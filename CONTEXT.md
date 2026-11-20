# PI Capacity Calculator — Full Context Document

> **Purpose of this file**: Complete reference for AI assistants working on this project.
> Keep this file in sync with `PI_SysMgm_Team_Capacity.html` after every change.

---

## 1. What This Tool Does

This is a **PI (Program Increment) Capacity Calculator** for the **DIVAR IP System Manager — SysMgm team** at IQSIGHT. It helps the team plan how much work (in Story Points) can realistically be delivered in each PI, broken down by iteration (sprint), accounting for:

- Individual team member focus hours per day
- Personal leave (days off per iteration)
- Public holidays per iteration
- Overhead/ceremony time (meetings, planning, etc.)
- Historical SP execution ratios (SP delivered per focus hour)

The output is: **estimated focus hours and estimated Story Points per iteration, per role (Dev / QA)**.

---

## 2. Architecture

| Property | Value |
|---|---|
| Type | Electron desktop app wrapping a single HTML file |
| Framework | None in the UI — vanilla JS, no build tools. Electron (`main.js` + `preload.js`) is the only added layer. |
| Styling | Inline `<style>` with CSS custom properties |
| Fonts | Google Fonts: DM Sans + DM Mono |
| Persistence | Plain OS file I/O via Electron's main process (local primary file + optional mirrored backup path) + localStorage (secondary backup) |
| Platform | Windows desktop (packaged via `electron-builder`, portable `.exe`) |
| Server required | No |

The UI lives in `PI_SysMgm_Team_Capacity.html` (structure/logic/calculations unchanged). `main.js` (Electron main process) and `preload.js` (context-bridge API) wrap it as a desktop app.

### Why a desktop app (changed 2026-06)
The original design used the browser's File System Access API to read/write a `.json` file directly. **Chrome refuses to grant write permission to files on a network share/mapped drive** via that API — confirmed via `SecurityError: ... Not allowed to request permissions in this context` even on a real, immediate button click — this is a deliberate, unfixable-from-the-page browser restriction, not a timing bug. Since the team's save file needs to live on `\\10.135.2.100\SysMgm\...`, the app was converted to an Electron desktop app: Node's plain `fs` calls (run in the main process, not the sandboxed renderer) aren't subject to that restriction, so they can write to the network path directly. This is currently a **single-user** setup (one person runs the app); see §3 for the local+mirror save model this enables.

---

## 3. Persistence & Save System

### Local primary + optional network mirror (desktop app, 2026-06)
- `primaryPath`: a local file path, chosen once via the "Connect a data file" banner (Open existing / Create new — native OS file dialogs via `window.electronAPI.pickOpenPath()` / `pickSavePath()`). Every save always writes here first.
- `backupPath` (optional): set via the **🗄 Backup** header button (`configureBackup()`). After every successful primary write, the same JSON text is mirrored here too — typically the team's network share, e.g. `\\10.135.2.100\SysMgm\PI Planning\...`. A backup write failure (e.g. share briefly unreachable) does **not** block or fail the save — the local primary copy is always safe; only the small "Backup"/"Backup failed" badge in the header reflects mirror status.
- Both paths persist across launches in a small `config.json` under Electron's `app.getPath('userData')` (read/written via IPC handlers `config:get` / `config:set` in `main.js`) — not IndexedDB (no browser storage involved anymore).
- **Auto-save**: every data change debounce-saves ~1.2s after the last edit (`scheduleSave()` → `autoSaveToFile()` → `safeWriteFile()`). **Save** button / **Ctrl+S** forces an immediate save and cancels the pending debounce.
- A `beforeunload` handler still warns if the window is closed inside the ~1.2s window before the debounced save fires.
- On launch, `initStorage()` reads the config, loads `primaryPath`'s content if present, and re-arms `backupPath` status.

### localStorage (secondary backup)
- Key: `sysmgm-pi-capacity-v1`
- Every data change triggers a silent `lsSave()` to localStorage
- On load, if the file is newer than localStorage (by `savedAt` timestamp), file wins; otherwise localStorage wins
- Still origin-scoped, but since this is now a single packaged Electron app (always the same origin), the old "double-click vs. dev server = different storage" caveat from the browser-based version no longer applies.

### Embedded backup history (unchanged behavior, new transport)
Every `safeWriteFile()` call re-reads `primaryPath` fresh first, and if writing would **shrink** existing data (fewer iterations/team members for any PI present in the file), it shows a confirm dialog detailing exactly what would be lost before proceeding. Either way, the previous on-disk version is folded into a rolling `backups` array (capped at `MAX_BACKUPS = 10`) **inside the saved JSON itself** — recovery works regardless of which machine/app version opens the file later.

**"🕑 History" button** (header): opens a panel listing the current on-disk version plus all embedded backups (date + PI/member counts), with a "Restore" action per backup. Restoring loads it into the in-memory session only — Save still needs to be clicked to commit it to disk.

Key functions: `safeWriteFile()`, `isDataShrinking(prev, next)`, `describeShrink(prev, next)`, `withBackupHistory(newState, previousData)`, `showHistoryPanel()`, `restoreBackup(i)`, `openDifferentFile()`, `configureBackup()`.

### Conflict detection (kept from the shared-drive design)
`lastKnownSavedAt` tracks the `savedAt` of the file content this session last read/wrote. Before every write, `safeWriteFile()` re-reads `primaryPath` **and `backupPath`** and picks whichever has the newest `savedAt` (via `newestState(...)`) to compare against `lastKnownSavedAt`:
- If it changed (e.g. the file was edited by another copy of the app, or a teammate's session mirrored a newer save to the shared backup file), the user is asked to either overwrite those changes or discard local edits and load the latest version — which is also written back into `primaryPath` so the two stay in sync.
- This is a basic last-writer-aware warning, not real merging.

### Two-person workflow via a shared backup file (2026-06)
Two people can use the app concurrently by each pointing their own `backupPath` at the *same* network file (their `primaryPath`s stay local/separate). To make that usable without manual reconnects:
- **On launch**, `initStorage()` reads both `primaryPath` and `backupPath` and adopts whichever is newer (`newestState()`); if the backup turns out to be newest, its content is written down into the local `primaryPath` too.
- **While running**, `checkBackupForUpdate()` polls `backupPath` every `BACKUP_POLL_MS` (20s) and also runs on window `focus`. If it finds a `savedAt` newer than `lastKnownSavedAt`, it pulls that data in automatically (`applyState` + sync down to `primaryPath`) and shows a toast — but only when there's no pending local autosave (`_autoSaveTimer`), so in-progress edits are never silently discarded. If edits are pending, the conflict is instead caught by `safeWriteFile()`'s own check on the next save.
- This is still not real merging — last-writer-wins between whichever of primary/backup is newest, same as the original shared-drive conflict detection, just extended to cover the backup-mirror direction too.

---

## 2b. Desktop App Files & Build

| File | Purpose |
|---|---|
| `main.js` | Electron main process. Creates the window, owns `config.json` (in `app.getPath('userData')`), and exposes IPC handlers: `config:get`, `config:set`, `dialog:pickOpen`, `dialog:pickSave`, `file:read`, `file:write`, `clipboard:writeText`, `report:export`, `tfs:getSettings`, `tfs:setSettings`, `tfs:testConnection`, `tfs:fetchSprint`, `tfs:openWorkItem`, `tfs:publishWikiPage` (see §6c/§6d/§6f). |
| `preload.js` | Context-bridge: exposes a safe `window.electronAPI` (`getConfig`, `setConfig`, `pickOpenPath`, `pickSavePath`, `readFile`, `writeFile`, `getTfsSettings`, `setTfsSettings`, `fetchTfsSprint`, `openTfsWorkItem`) to the renderer. `contextIsolation: true`, `nodeIntegration: false`. |
| `package.json` | `npm start` → `electron .` (dev run). `npm run dist` → `electron-builder`, produces a portable `.exe` under `dist/` (Windows target, no installer required). `npm run icon` → regenerates `build/icon.ico`. |
| `scripts/build-icon.js` | Generates `build/icon.ico` from scratch (hand-rolled PNG encoder + ICO container, no image libraries) — a navy rounded square with two DEV/QA-colored bars, matching the app's own `--navy`/`--blue`/`--teal` palette. `build.win.icon` in `package.json` points at it. Re-run `npm run icon` after editing the design. |
| `scripts/release.js` | `npm run release -- <version>` automates the full release process (see below). |

To run: `npm install` once, then `npm start`. To produce a distributable: `npm run dist` (downloads Electron's prebuilt binaries on first run — needs internet access once).

### Cutting a release (since v1.4.3)
```
npm run release -- 1.5.0
npm run release -- 1.5.0 --message "Fix X, add Y"
npm run release -- 1.5.0 --notes-file release-notes.md
```
Runs the full sequence that used to be done by hand: bump `package.json` version → `git add -A` + commit (skipped if nothing changed) → `git push` → `npm run dist` → verify the expected `.exe` exists in `dist/` → `git tag -a vX.Y.Z` + push the tag → `gh release create` with the `.exe` attached. Requires GitHub CLI (`gh`) installed and authenticated (`gh auth login`) — already set up on the machine this was built on. Without `--message`/`--notes-file`, both the commit and the release notes default to "Release vX.Y.Z".

### State object (`getState()`)
```json
{
  "version": 1,
  "savedAt": "ISO timestamp",
  "piList": [...]
}
```
`team`, `ratios`, and `overhead` all live per-PI inside each `piList[i]` entry, not at the top level (older saves with a top-level `team`/`ratios`/`overhead` are migrated by `applyState()` — each PI lacking its own copy gets one backfilled, falling back to the built-in `DEFAULTS.overhead` if there was no legacy global value either). This means each PI's ceremonies/overhead list is fully independent: adding, removing, or re-allocating hours for a ceremony in one PI never affects any other PI. When written to a connected file, `safeWriteFile()` adds a `backups` array on top (see storage caveat above) — `applyState()` ignores that field on load.

### Section collapse state
- Stored separately in localStorage under key `sysmgm-sections-v1`
- Each collapsible section header has a unique `id` (e.g. `hdr-config`, `hdr-timeoff`)
- Restored on boot via `restoreSectionState()`

---

## 4. Data Model

### 4.1 `piList` — Program Increments

```javascript
piList = [
  {
    id: 19,                          // PI number
    status: 'planning',              // 'historical' | 'current' | 'planning' | 'future'
    actual: null,                    // null for non-historical; object for historical (see below)
    wikiUrl: '',                     // pasted TFS wiki page URL for this PI (see §6f) — each sprint publishes as a child page under it
    iterations: [
      {
        id: '19.1',                  // iteration ID string
        sprint: 157,                 // sprint number
        days: 15,                    // working days in this sprint (default: 15)
        label: '19.1 — Sprint 157',  // display label
        dateStart: '2026-06-24',     // ISO date string
        dateEnd: '2026-07-14',       // ISO date string
        dates: '24 Jun → 14 Jul 2026', // formatted display string
        holidays: [                  // public/team holidays in this sprint
          { name: 'Bank Holiday', days: 1 }
        ],
        devSPexec: null,             // actual executed DEV SP (null = not yet tracked)
        qaSPexec: null,              // actual executed QA SP (null = not yet tracked)
        tfsUrl: '',                  // pasted TFS sprint backlog URL (see §6c) — same URL used by all three pulls below
        tfsPIPlanned: null,          // {devSP,qaSP,teamSP,totalSP,itemCount,items,pulledAt} | null — "Pull PI Planned", clicked once during PI planning before any sprint starts (see §6e)
        tfsPlanned: null,            // same shape | null — last "Pull Sprint Planned" (clicked at this sprint's own sprint-planning ceremony)
        tfsExecuted: null            // same shape | null — last "Pull Sprint Executed" (also writes devSPexec/qaSPexec)
      }
      // ...more iterations
    ]
  },
  {
    id: 18,
    status: 'historical',
    iterations: [],
    actual: {
      devH: 337,                     // total DEV focus hours delivered
      devSPest: 151,                 // total DEV SP estimated
      devSPexec: 223,                // total DEV SP actually executed
      devRatio: 0.45,                // ratio used at planning time
      qaH: 554,
      qaSPest: 139,
      qaSPexec: 117,
      qaRatio: 0.25
    }
  }
]
```

**4 PI statuses:**
| Status | Meaning | Badge color |
|---|---|---|
| `historical` | Past PI — dates all in the past, actuals recorded | grey |
| `current` | Currently running PI (dates span today) but not the planning focus | green |
| `planning` | The PI actively being planned in the tool (single) | blue |
| `future` | PI whose dates are entirely in the future | yellow |

Rules:
- Exactly one PI can have `status: 'planning'` at a time (via "Set as Planning" button)
- `getCurrentPI()` returns the `planning` PI, falling back to `current` for backward compat
- Historical PIs cannot be set as planning
- Switching planning PI uses `inferStatusFromDates(prev)` to determine the previous PI's new status
- `piList` is always sorted by PI id ascending in the tab switcher

### 4.2 `team` — Team Members

```javascript
team = [
  {
    name: 'Dev A',
    role: 'Dev',                       // 'Dev' | 'QA'
    focusHpd: 3.5,                     // focus hours per day (primary capacity field)
    activeIter: ['19.1','19.2','19.3','19.4','19.5'], // iteration IDs this person is active in
    daysOff: {
      '19.1': 2,                       // personal leave days per iteration
      '19.3': 5
    }
  }
]
```

**Important**: `focusHpd` is the **primary** capacity field. There is NO `avail%` field stored — the % shown in the UI is derived: `avail% = (focusHpd / focusStd()) * 100`.

Current team (names anonymized — see local data file for real names):
| Name | Role | focusHpd | Rationale |
|---|---|---|---|
| Dev A | Dev | 3.5 h/day | Still learning, 6h contracted, 2.5h overhead = 3.5h focus |
| Dev B | Dev | 3.5 h/day | Same as above |
| QA A | QA | 1.5 h/day | Hybrid QA+PO role, 4h contracted, 2.5h overhead = 1.5h focus |
| QA B | QA | 5.5 h/day | Full-speed, 8h contracted, 2.5h overhead = 5.5h focus |

### 4.3 `overhead` — Ceremonies & Activities (per-PI, changed 2026-06)

Lives inside each `piList[i].overhead` — independent per PI, same as `team` and `ratios`. The global `overhead` variable always points at the *viewed* PI's array (kept in sync in `renderAll()`, `setViewedPI()`, `restoreViewedPI()`, and `applyState()`), so edits, additions, and removals only ever affect that one PI.

```javascript
pi.overhead = [
  { name: 'Daily Meeting',        hpd: 0.250 },
  { name: 'Sprint Planning Pt 1', hpd: 0.100 },
  { name: 'Sprint Planning Pt 2', hpd: 0.067 },
  { name: 'Sprint Review',        hpd: 0.100 },
  { name: 'Retrospective',        hpd: 0.100 },
  // ... more rows
]
```

A new PI created via "Add PI" starts with a **copy** of the planning PI's `overhead` (`addPIFromForm()`), same as it does for `team`/`ratios` — a convenient starting point, but a separate array from that point on.

`hpd` = hours per working day consumed by this ceremony/activity.
`totalOverhead()` = sum of all `hpd` values ≈ 2.501 h/day.

---

## 5. Core Formulas

### focusStd()
```
focusStd() = FULL_H - totalOverhead()
           = 8 - 2.501
           = 5.499 h/day   (standard max focus for a full-time person)
```

### memberFocusInIteration(m, it)
```
workingDays = it.days - holidayDays(it) - m.daysOff[it.id]
focusHours  = m.focusHpd × workingDays
```

**No availability percentage is applied here.** `focusHpd` is already the calibrated daily focus output for that person. This matches the Excel model where each person's focus hours are entered directly.

### Capacity per iteration
```
devH = sum of focusHours for all DEV members active in iteration
qaH  = sum of focusHours for all QA members active in iteration

devSP = devH × ratio_dev
qaSP  = qaH  × ratio_qa
```

### Availability % (display only)
```
avail% = (focusHpd / focusStd()) × 100
```

This is never stored — it is always recomputed from `focusHpd` for display.

### Ratio (SP per focus hour)
Entered manually in the Config section. Derived from historical execution:
```
ratio = executed_SP / focus_hours_delivered
```

**Important**: the ratio must be calibrated against the same hours formula. If importing a ratio from an external Excel that uses a different hours formula (e.g. double-counting team size), the ratio will need adjustment.

---

## 6. UI Sections

### Section 1: Configuration
Collapsible. Contains three sub-areas:

**PI Management**
- Add / remove PIs (id + status)
- Add / edit iterations per PI (label, sprint number, date range, working days, public holidays)
- Set which PI is "current"
- Date pickers for `dateStart` / `dateEnd`; `days` field auto-set from date range

**Team Table**
- One row per team member: Name, Role (Dev/QA), Focus h/day ↔ % (two linked inputs), Active iterations (clickable chips), Remove button
- Changing the h/day input updates the % input (and vice versa) instantly without re-rendering the table
- Changing overhead ceremonies also refreshes the % column (since focusStd() changes)
- Add member form at the bottom

**Overhead / Ceremonies Table**
- One row per ceremony: editable name, h/day input, computed h/sprint
- Add / remove rows freely
- **Per-PI** (changed 2026-06): the table shown follows the viewed PI's own `overhead` array — adding/removing/re-allocating a ceremony only affects that PI. A new PI starts with a copy of the planning PI's list as a starting point.
- Total overhead row at the bottom
- Summary line: `8h full day − X.XXh overhead = Y.YYh/day focus`
- **Ratio SP/h inputs**: manually entered, one for DEV and one for QA

### Section 1b: Team Member Cards (new layout)
The team table was replaced with a card grid (`div.member-cards-grid`, `id="team-tbody"`). Each card shows:
- Top-left: role selector styled as a badge (`.member-role-select`)
- Name input (`.member-card-name`)
- Focus % + computed h/day (`.member-card-meta`)
- Active iteration chips (same `iterChips()` function)
- Note field at the bottom
Cards have a coloured top border: blue for Dev, teal for QA.

### Section 2: Time Off & Absences
Collapsible. Two sub-sections:

**Shared Events** (formerly "Public Holidays") — deducts from all active members in the iteration. Used for: public holidays, PI Planning, team-building days, or any event affecting the whole team. Stored as `it.holidays = [{name, days}]`.

**Personal Leave** — one row per active team member. Columns = one per iteration.
- Each cell shows the iteration date range as reference
- Number input: days off for that member in that iteration
- Clamped to max `it.days - holidayDays(it)` (can't take more days off than available working days)
- Changes instantly recalculate the capacity table

### Section 3: Capacity per Iteration
Collapsible. Main output table.
- Rows = iterations of current PI
- Columns: Iteration name/dates/working days info, DEV Hours, DEV SP Est., QA Hours, QA SP Est., Total SP Est.
- Footer row = PI totals
- Shows public holiday badges and working days count per iteration
- **Colour coding**: each row gets a green/amber/red dot (`.util-dot`) and tinted background based on utilisation ratio = (actual hours) / (baseline hours with no leave). Green ≥ 90%, amber 75–90%, red < 75%.
- **SVG capacity chart** below the table (`#cap-chart-wrap`): stacked bar chart (DEV blue, QA teal) per iteration, rendered by `renderCapacityChart(iters, devHArr, qaHArr)`. Uses a fixed `viewBox="0 0 800 …"` with `width:100%` for responsive scaling.

### Section 4: PI Totals
Collapsible. Summary cards:
- Total DEV hours / SP estimate
- Total QA hours / SP estimate
- Active iteration count
- Baseline focus hours per member (15-day sprint, no time off)

### Section 5: Historical Comparison
Collapsible. Shows all historical PIs with their actual execution data.
- DEV and QA: hours, SP estimated, SP executed, ratios
- Editable inline (toggle edit mode per PI)
- Delta rows: difference between estimated and executed
- Ratio suggestion: weighted average of historical ratios, shown as a hint near the ratio inputs

### Sprint Actuals (within Historical section)
- Per-iteration `devSPexec` and `qaSPexec` fields for the current PI
- Allows tracking actual SP delivered per sprint as the PI progresses

---

## 6c. TFS Sprint Pull (Planned / Executed Story Points)

Each iteration can be linked to its TFS (on-prem Azure DevOps Server) sprint backlog URL, and two buttons under its row in Sprint Actuals pull Story Points directly from TFS via WIQL instead of typing them in by hand:

- **⬇ Pull Sprint Planned** — click at sprint start. Pulls whatever's currently in the sprint (no state filter beyond excluding `Removed` items). Stores the result in `it.tfsPlanned` only — never touches `devSPexec`/`qaSPexec` or any capacity-model estimate.
- **⬇ Pull Sprint Executed** — click at sprint end. Only counts items with `System.State === 'Closed'`. Stores the result in `it.tfsExecuted` **and** writes `it.devSPexec`/`it.qaSPexec` from it (same effect as typing those fields manually — still editable afterward).
- **⬇ Pull PI Planned** — a third pull, same URL and query as Sprint Planned, but meant to be clicked once during the overall PI planning session, before any sprint has started. Stores the result in `it.tfsPIPlanned`. See §6e.

Both buttons are disabled until `it.tfsUrl` is set (edited per-iteration in PI Management → Iterations, a plain text field, persisted via the existing generic `updateIterField()`).

**Work item classification** (`main.js`, `classifyAndSum()`):
- `Bug` → always **Dev**, regardless of tags.
- `User Story` → `System.Tags` is split on `;`, trimmed, and exact-matched (case-insensitive, not substring — the field also carries unrelated tags like `19C`/`19Planned`/`SysMgm Core 3.1.0`) against `DEV`/`QA`: `DEV`-only → Dev, `QA`-only → QA, both or neither → **Team**.
- Team is a third bucket. **It is never folded into `devSPexec`/`qaSPexec` or the DEV/QA ratio-calibration math** (`computeActualRatios()`, `devActR`/`qaActR`, and the SP/h ratios shown throughout) — those stay Dev/QA-only, since a ratio is "SP per focus-hour of a role" and Team has no role/hours of its own. But every **"total executed SP" rollup** (Sprint Actuals table's `Total exec.` column, the Historical Comparison card's `Total SP` / `SP delivered` / `Team SP executed` rows, `piTotalSP()`, and the capacity chart's "SP exec." line) **is Dev + QA + Team** — see `effectiveActual()`'s `teamSPexec` field, summed from `it.tfsExecuted.teamSP` across the PI's iterations (`null` if no Executed pull exists yet, so these totals fall back to Dev/QA-only until TFS data is pulled).
- Story points come from `Microsoft.VSTS.Scheduling.StoryPoints` (confirmed via API probe against this org's process template — there's no separate Effort field in use).

**Result shape** (`it.tfsPlanned` / `it.tfsExecuted`): `{devSP, qaSP, teamSP, totalSP, itemCount, pulledAt, items}`, where `items` is every work item the WIQL query returned (not just the counted ones): `{id, title, type, state, sp, bucket, counted}`. `counted` is `false` for an `executed`-mode item that isn't `Closed` yet (still shown, dimmed, so it's visible but visibly excluded) — always `true` for `planned` mode. Re-pulling overwrites the previous snapshot (no history kept beyond the file's own embedded backups).

**Per-item visibility**: each breakdown line has a "▸ View items" toggle (`toggleTfsDetails()`, UI-only expand state in the module-level `_tfsDetailsOpen` Set — not persisted/saved) that lists every item grouped by bucket (Dev/QA/Team) with its title, type, state, and SP — built for exactly this kind of audit: spotting a User Story that landed in "Team" because its `DEV`/`QA` tag is missing or misspelled. Clicking an item's `#id` calls `tfs:openWorkItem` (main process, via `shell.openExternal`) to open that work item directly in TFS in the default browser, so a tagging mistake can be fixed on the spot.

**Planned vs Executed diff**: once both `tfsPlanned` and `tfsExecuted` exist for an iteration, a "▸ Compare Planned vs Executed" toggle appears (`tfsDiffSection()`/`tfsDiff()`/`tfsDiffPanel()`), matching items by id between the two snapshots to show: items **added mid-sprint** (in Executed, not in Planned), items **removed/descoped** (in Planned, not in Executed — including anything whose `System.State` became `Removed`, since the WIQL query excludes those), and items whose **bucket changed** between the two pulls (e.g. a missing DEV/QA tag got fixed in TFS in between). This is a pure client-side comparison of the two already-stored item lists — no extra TFS call.

**Forgotten-tag highlighting**: this team's title convention is that every User Story starts with `[Dev]`, `[QA]`, or `[SysMgm Team]`. `titlePrefixBucket()` parses that literal prefix (case-insensitive) and `tfsTagMismatch()` compares it against the item's actual classified bucket — if they disagree (almost always a missing/wrong `DEV`/`QA` tag in TFS, since a `[Dev]`-titled story landing in "Team" means the tag never got added), the row is highlighted red with a "⚠ check tag" badge and a tooltip explaining the mismatch, in both the per-pull item list and the diff panel's Added/Removed sections (shared row renderer `tfsItemRow()`). **Bugs are always exempt** — per the existing rule they count as Dev regardless of tags, and now also regardless of title, so no mismatch is ever flagged for them. A title with no recognized `[...]` prefix (or a non-convention bracket like `[3.1 RC]`) is simply not checked — only an explicit, recognized prefix can produce a mismatch.

**Per-bucket SP subtotal**: the expanded item list's bucket headers (`tfsItemsTable()`) show both the item count and the summed Story Points for that bucket (e.g. "Dev — 5 items, 33 SP"), counting only items where `counted !== false` — so it always matches the Dev/QA/Team numbers in the breakdown line above it, just broken out per bucket for quick scanning instead of needing to add up each row by hand.

**Clearing/undoing a pull**: each breakdown line has a "🗑 Clear" action (`clearTfsPull(iterId, mode)`) for exactly the "clicked the wrong button" case (e.g. pulled Executed when Planned was meant) — it wipes `it.tfsPlanned`/`it.tfsExecuted` back to `null` (with a confirm dialog) so the correct button can be pulled again. Clearing an **Executed** pull also resets `it.devSPexec`/`it.qaSPexec` back to `null`, since those were written from that pull — otherwise the wrong numbers would silently remain in the ratio-calibration math after the snapshot itself is gone.

**"TEAM exec. SP" column and Total exec. including Team**: the Sprint Actuals table has a `TEAM exec. SP` column (sourced from `it.tfsExecuted.teamSP`, `—` until an Executed pull exists) and its `Total exec.` column/footer is `devSPexec + qaSPexec + teamSP` — this is what the user shows at sprint review. The same Dev+QA+Team total is used everywhere else "total executed" is shown (Historical Comparison card, `piTotalSP()`, capacity chart's "SP exec." line — see `effectiveActual()`'s `teamSPexec`). The DEV/QA ratio-calibration math (`devSPexec`, `qaSPexec`, and every SP/h ratio) stays Dev/QA-only — only the rollup totals changed.

**Capacity flags on a pull**: `capacityFlag(pulledSP, capacitySP)` compares a pulled Dev or QA SP figure against that iteration's modeled capacity (hours × ratio — the same `devSPest`/`qaSPest` shown in the Capacity-per-iteration table and in this table's own est. columns) and renders a small colour-coded badge next to it in `tfsBreakdownLine()`, both for Planned and Executed pulls: green `●` 85–105% (on target), amber `▲`/`▼` 70–85%/105–115% (moderate over/under), red `▲`/`▼` outside that (significant over/under). A one-line legend explaining the thresholds appears above the table whenever any iteration has a `tfsUrl` set. Team has no capacity model (team members are Dev or QA roles, not a separate "Team" role), so it is never flagged — shown as plain informational text only.

**URL parsing** (`main.js`, `extractIterationPath()`): the pasted TFS URL (e.g. `.../_sprints/backlog/{team}/{project}/2026/PI20 - SysMgm/Sprint 20-1 (162)`) is used **only** to extract the path segments after `_sprints/backlog/{team}/{project}/` (URL-decoded, `\`-joined) — these become the `System.IterationPath` filter in the WIQL query. The actual HTTP request always targets the **configured** `tfsCollectionUrl`/`tfsProject` (set once via TFS Settings), never a host parsed from the pasted URL — this is deliberate, so a wrong or malicious pasted link can never redirect the PAT to another server.

**PAT security**: the PAT is entered once via the **🔗 TFS Settings** header button and encrypted at rest using Electron's `safeStorage` (OS-level — DPAPI on Windows), stored as `tfsPatEncrypted` in `config.json`. It's decrypted only inside `main.js`, only at the moment of the TFS HTTP call, and is never sent back to the renderer — `tfs:getSettings` returns only `{collectionUrl, project, hasPat: boolean}`. This is why TFS settings use dedicated `tfs:getSettings`/`tfs:setSettings` IPC channels instead of the generic `config:get`/`config:set` (those echo the full config object back unredacted).

Key functions: `pullTfsSprint(iterId, mode)`, `clearTfsPull(iterId, mode)`, `tfsItemRow(item, showState)`, `titlePrefixBucket(title)`, `tfsTagMismatch(item)`, `tfsBreakdownLine(result, label, iterId, mode, devCap, qaCap)`, `capacityFlag(pulledSP, capacitySP)`, `tfsItemsTable(items)`, `tfsDiff(plannedItems, executedItems)`, `tfsDiffPanel(diff)`, `tfsDiffSection(it)`, `toggleTfsDetails(iterId, mode)`, `openTfsWorkItem(id)` (renderer); `extractIterationPath()`, `runWiql()`, `getWorkItemsBatch()`, `classifyItems()`, `encryptPat()`/`decryptPat()` (main process).

---

## 6d. TFS-Derived Insights, Sprint Review Panel & Velocity Trend

Built on top of 6c, using only data already pulled — no new TFS calls beyond Test Connection.

**Spillover callout**: in `tfsBreakdownLine()`, an Executed pull's items with `counted === false` (still open, not `Closed`) are summed into a "⚠ N spilled over (X SP)" badge next to the breakdown line, so incomplete work is visible without opening the item list. Planned pulls never show this (nothing is excluded there).

**Test Connection** (`TFS Settings` modal → 🔌 Test Connection button, `testTfsConnectionClick()`): validates Collection URL + Project + PAT against TFS's project-metadata endpoint (`_apis/projects/{project}`, no iteration path needed) via `main.js`'s `testTfsConnection()` / `ipcMain.handle('tfs:testConnection', ...)`, so a typo or bad PAT is caught immediately instead of on the first real pull. Uses whatever is currently typed in the modal, falling back to the already-saved setting for any blank field (so the PAT doesn't need retyping to re-test after it's saved).

**Sprint Report panel** (📋 Sprint Report button on each iteration's TFS row, next to Pull Planned/Executed — shown once either pull exists; function/element names still say "SprintReview" internally, e.g. `showSprintReviewPanel()`/`#sprint-review-panel` — only the user-facing label changed, to avoid a churn-for-churn's-sake rename of every identifier): a modal (`showSprintReviewPanel(iterId)` / `#sprint-review-panel`) assembling everything to check about a sprint — **works as either a pre-sprint planning snapshot or a post-sprint review**, same report either way (see "Planning vs review" below). A small grouped-bar chart (`buildReportChartSvg(cap, planned, executed)` — Capacity/Planned/Executed per Dev/QA/Team, pure static SVG) sits at the top, followed by the stat sections from `buildSprintReviewSections(it)`:
- **Team** — one row per member active in that iteration, `name → role[/tag]` (see "Member tag" below)
- Capacity vs Pulled — Dev capacity, QA capacity, and **Total capacity (Dev+QA)**, all modeled via `iterCapacityEstimate(it)` (hours × ratio); each pull's Dev/QA/Team/Total SP with % of capacity
- **Time Off** — shared/public holidays and team members' personal days off for that iteration (see "Time Off section" below)
- Spillover (Executed only, same figures as the breakdown line's badge)
- **Bug vs Story split** (`bugStorySplit(items)`, Executed only) — SP and count of `Bug`-type vs `User Story`-type *counted* items, a quick quality signal (a high Bug SP share usually means rework rather than new delivery)
- Sprint Planned vs Sprint Executed diff summary (added/removed/bucket-changed counts) plus **churn %** (see §6e for the PI Planned vs Sprint Planned **drift %** equivalent)

(Tag-mismatch *counting* was dropped from the report — the per-item "⚠ check tag" badges in the Work Items lists below already surface it inline, and the report is meant for presenting outward, not for TFS data-quality auditing.)

**Planning vs review — no separate mode, just content**: there's deliberately no "Planning" vs "Review" toggle or banner — the same report is opened the same way regardless of what's been pulled, and the title (see "Product/team name" below) never says which one it is, since a report pulled before the sprint ends shouldn't be mistaken for a finished review just because the title looks the same either way. Instead, the Review group (see "Section order" below) always includes an **Executed** section — if `it.tfsExecuted` is missing, with a `note` ("⏳ Not pulled yet — this is still a planning snapshot, not a completed review.") instead of being silently omitted — so scrolling down the report itself tells you which one you're looking at. A section's `note` is a full-width line, not a label/value row — this sentence is long enough that squeezing it next to a "Status" label made the wrapped text visually collide with the label (every one of `showSprintReviewPanel()`/`buildSprintReviewText()`/`buildSprintReviewExportHtml()` renders `s.note` as its own line, separately from `s.rows`). (A missing `tfsPlanned` with `tfsExecuted` present — the rarer case — doesn't get this treatment; a Planned section simply isn't there, which is self-evident.) An earlier version of this put a colour-coded status banner at the top of the report instead — removed per feedback, since it visually implied two different report "modes" rather than one report whose content just reflects whatever's been pulled so far.

**PDF/image export matches the in-app report** (user request): `buildSprintReviewExportHtml()` uses the same bordered card grid for the summary sections and the same titled card around each Work Items table. `report:export` in `main.js` renders it 1500px wide. At the old 900px the Dev/QA/Team columns were so narrow that titles wrapped one word per line. The PDF gets the same width by printing A4 landscape at 70% scale with small margins. In the export, rows and summary cards don't split across PDF pages, and the table header repeats on each page. "No longer in this pull" comment rows appear only in the live app (`orphanRows` returns nothing when not editable). Like the wiki, the exports leave them out.

**Section order — two groups, not one flat list**: `buildSprintReviewSections(it)` returns `{ planning, review }` (two separate arrays), not one flat section list, specifically so the Work Items tables — which aren't simple label/value rows and so can't live inside a `sections` entry — can be slotted between the two groups rather than only ever trailing at the very end. Rendered order (`showSprintReviewPanel()`, `buildSprintReviewText()`, `buildSprintReviewExportHtml()` — each does `renderSections(planning)`, then Work Items — Planned, then `renderSections(review)`, then Work Items — Executed): **Planning** = Team → Capacity vs Pulled → Time Off → Planned stats → *Work Items — Planned*; **Review** = Executed stats (or its "not pulled yet" placeholder) → Planned vs Executed diff/churn (only if both pulled) → *Work Items — Executed*. Everything planning-related is fully together first, then everything execution/review-related together after — not interleaved.

Below the stats, the panel also lists **every work item with its ID** — `tfsItemsTable(it.tfsPlanned.items)` / `tfsItemsTable(it.tfsExecuted.items)`, the same grouped-by-bucket, tag-mismatch-highlighted component already used under each pull's "▸ View items" toggle, reused here so the two never drift out of sync.

**Churn % — fixed formula**: originally `(added + removed) / plannedItemCount`, which could read like 1700% whenever Planned was pulled very early with only a couple of items staged (tiny denominator). Now union-based: `unionSize = plannedCount + added.length`; `churnPct = (added + removed) / unionSize` — mathematically bounded 0–100% ("what fraction of all items touched by either pull actually differ"), shown with both the percentage and the raw counts (e.g. "94% (17 of 18 total items differ)") so the number is self-explanatory.

`📋 Copy as text` (`copySprintReview()` → `buildSprintReviewText(it)`, using `itemsAsText(items)` for the item lists) copies the same content — stats **and** every work item — as plain text via a dedicated `clipboard:writeText` IPC channel (`main.js`, Electron's `clipboard.writeText()` — not `navigator.clipboard`, which is unreliable from a `file://`-loaded renderer).

**📄 Export PDF / 🖼 Export Image**: `exportSprintReview(format)` builds a fully self-contained HTML document (`buildSprintReviewExportHtml(it)` — own `<style>` with a copy of the app's `:root` color tokens, since `tfsItemsTable()`'s inline styles reference `var(--red-light)` etc. and the export renders in a separate document with no access to the live page's stylesheet) and sends it to `main.js`'s `report:export` IPC handler. That handler writes the HTML to a temp file, loads it into a **hidden, offscreen `BrowserWindow`** (`show:false` — same trick used for thumbnail generation; it still renders normally, just never appears on screen), then either calls `webContents.printToPDF({printBackground:true, pageSize:'A4'})` (PDF) or resizes the window to the content's full `scrollHeight` before `webContents.capturePage()` + `nativeImage.toPNG()` (PNG — the resize avoids the capture being clipped to an arbitrary initial viewport/scroll position, which a direct capture of the live modal would suffer from since it uses `max-height:80vh;overflow:auto`). Prompts a save path via `dialog.showSaveDialog` first, so nothing is generated if the user cancels. The hidden window and temp file are always cleaned up (`finally` block).

**Velocity trend chart** (`renderVelocityTrendChart()`, `#velocity-chart-wrap` above the PI selector pills in Historical Comparison): a cross-PI view (unlike the Capacity chart, which is one PI's iterations at a time) — a stacked bar per historical/current PI of Dev+QA+Team *executed* SP (via `effectiveActual(pi).teamSPexec` etc.), so a long-run trend is visible without hopping between Historical cards. Hidden when fewer than 2 PIs have any executed data. Each stacked segment carries a native SVG `<title>` hover tooltip ("Dev: 69 SP") plus a permanent white value label centered in the segment when it's tall enough not to overflow (`segment()` helper inside `renderVelocityTrendChart()`) — so the Dev/QA/Team breakdown behind each bar's total is readable at a glance, not just on hover.

**Local file path on hover**: `setSaveStatus()` now sets `#save-status`'s `title` to `Local file: {primaryPath}` (previously a static "Click to connect a file" string that never reflected the connected file — the backup-mirror status badge already did this correctly via `setBackupStatus()`, the primary one just hadn't been wired up the same way).

**Accepting a tag mismatch**: `titlePrefixBucket()`'s title-vs-tag check is a heuristic, not a rule — the team's convention is sometimes deliberately broken (e.g. a `[SysMgm Team]`-titled story tagged `DEV` because Dev actually did the work). A "⚠ check tag" badge's **✓ accept** link calls `acknowledgeTagMismatch(itemId)`, which adds the work item id to a new global, persisted `ackedTagMismatches` array (top-level state alongside `piList`, included in `getState()`/`applyState()` — global because a TFS work item id is stable regardless of which sprint it's pulled into). `tfsTagMismatch(item)` is acknowledgment-aware (returns `null` for an acked id) and is what everything — red highlighting, `itemsAsText()`'s `[check tag]` flag — treats as "is this still a problem"; `rawTagMismatch(item)` is the unaware original check, used only to know an item *was* flagged so an accepted one can still show a muted "✓ accepted" badge with an **undo** link (`unacknowledgeTagMismatch(itemId)`) rather than looking identical to an item that was never flagged. Both actions call `refreshAfterTagAck()`, which re-renders Sprint Actuals (`recalc()`) and, if open, re-renders the Sprint Report modal too — it isn't part of `recalc()`'s render chain since it only opens on a button click.

**Clickable work item IDs in exports**: the live app's item rows open a work item via `onclick="openTfsWorkItem(id)"` → IPC → `shell.openExternal()`, which does nothing once rendered into a static PDF/PNG. `tfsItemRow()`/`tfsItemsTable()` take an optional `linkBase` param — when set (export only), the `#id` renders as a real `<a href="{collectionUrl}/{project}/_workitems/edit/{id}">` instead, which Chromium's `printToPDF()` preserves as an actual clickable link in the PDF (a PNG obviously can't be clickable either way, but the same markup is used for both — harmless). `exportSprintReview()` fetches `tfs:getSettings` for the `collectionUrl`/`project` before building the export HTML; the accept/undo controls are hidden in this mode (`linkBase` truthy) since they rely on the live app's JS, which the offscreen export document doesn't have.

**Product/team name**: a free-text field (`productName`, header input `#product-name-input`, e.g. "DIVAR IP System Manager") so another team can tell whose Sprint Report they're looking at when it's presented or shared. Persisted as top-level state (`getState()`/`applyState()`, alongside `piList`/`ackedTagMismatches` — travels with the save file, not per-machine `config.json`, since it's identity info about the data, not this machine's connection settings). `updateProductName(val)` on input; `renderAll()` reflects the stored value back into the field (guarded by `document.activeElement !== pnEl` so it never clobbers mid-typing). The report title is a single line everywhere it appears (modal title, copy-as-text header, PDF/image `<title>`/`<h1>`): `{productName} — {it.label || it.id}` (e.g. "DIVAR IP System Manager — Sprint 20-3 (164)") — `productName` and its trailing " — " are simply omitted when not set. Deliberately has **no "Sprint Review"/"Sprint Report" wording and no planning-vs-review indicator** in the title itself — see "Planning vs review" above for why.

**Time Off section**: a new section in `buildSprintReviewSections(it)`, placed right after Capacity since it's the direct explanation for a lower-than-"full" capacity number. Lists the iteration's shared/public holidays (`it.holidays`, `{name, days}`) and any team member's personal days off for that iteration (`m.daysOff[it.id]`, only members active in that iteration) — the same two time-off sources already tracked in the Time Off & Absences section, just surfaced here for the sprint being reviewed instead of requiring a separate check.

**Work item row styling**: `tfsItemRow()` rows now get a `border-bottom` separator and fixed `min-width`s on the ID/Type/State/SP columns so a long item list reads as an aligned table instead of a ragged wall of text (prompted by a long list looking "confusing"). The State column is now a colour-coded badge (`stateBadge(state)`, table `STATE_BADGE_COLORS`) reading as a progress gradient: `New` neutral slate → `Active` amber → `Resolved` teal → `Closed` green (unrecognized states fall back to neutral slate).

**Member tag (e.g. "PO")**: team members gained an optional free-text `tag` field (`m.tag`, small input next to the name in each member card, `.member-card-tag`) for a second hat someone wears beyond their Dev/QA role — e.g. a QA who's also the PO shows as **QA/PO**, not just QA. Purely a display label; doesn't affect capacity, ratios, or any calculation — only how the person is labeled.

**Team section**: see the "Sprint Report panel" bullet list above — `buildSprintReviewSections(it)` opens with a **Team** section, one row per member active in that iteration (`team.filter(m => m.activeIter.includes(it.id))`), `name → role[/tag]` (e.g. "Joao Pires → QA/PO") — so someone outside the team can see who was on the sprint without asking.

Key functions added: `testTfsConnection()` / `tfs:testConnection`, `report:export` (main process); `testTfsConnectionClick()`, `iterCapacityEstimate(it)`, `bugStorySplit(items)`, `buildSprintReviewSections(it)`, `buildReportChartSvg(cap, planned, executed)`, `itemsAsText(items)`, `showSprintReviewPanel(iterId)`, `hideSprintReviewPanel()`, `buildSprintReviewText(it)`, `buildSprintReviewExportHtml(it, collectionUrl, project)`, `exportSprintReview(format)`, `copySprintReview()`, `renderVelocityTrendChart()`, `acknowledgeTagMismatch(itemId)`, `unacknowledgeTagMismatch(itemId)`, `refreshAfterTagAck()`, `rawTagMismatch(item)`, `updateProductName(val)`, `stateBadge(state)` (renderer); `clipboard:writeText` IPC exposed as `copyToClipboard`, `report:export` exposed as `exportReport` (preload.js).

---

## 6e. PI-Planned Pull & Parent/Feature Grouping

Built on top of 6c/6d. Two asks drove this: (1) a sprint is actually planned twice — once during the overall PI planning session (before any sprint in the PI has started, when all 4 sprints' backlogs get populated at once) and again at that specific sprint's own sprint-planning ceremony, which may have drifted from the original PI-level plan — so there should be a way to capture and compare both, plus the eventual Executed pull; (2) in TFS, work is actually organized Feature → (Dev/QA/Team) User Stories/Bugs, and the existing flat bucket list didn't reflect that.

**"Pull PI Planned" — a third per-sprint pull, not a separate PI-level query**: each iteration now has a third field, `it.tfsPIPlanned` (same shape as `tfsPlanned`/`tfsExecuted` — see §4.1), alongside a third button in its Sprint Actuals row: "⬇ Pull PI Planned". It uses the **exact same `it.tfsUrl`** as the other two buttons and the exact same non-recursive WIQL query (`[System.IterationPath] = '{path}'`) — work items are already assigned to their target sprint's iteration path as soon as they're scoped during PI planning, so no special "whole PI" query is needed. The only difference from "Pull Planned" is **when** it's clicked: once, during PI planning, before any of the PI's sprints have started. `pullTfsSprint(iterId, mode)` now takes `mode: 'piplanned' | 'planned' | 'executed'` — `'piplanned'` is translated to a plain `mode:'planned'` IPC call (TFS/`main.js` only knows Planned-vs-Executed, i.e. whether the Closed-state filter applies) and the result is just stored in a different local field. `clearTfsPull(iterId, mode)` and `tfsBreakdownLine()` both already took `mode` as a plain string key, so they support `'piplanned'` for free.

*(Note: an earlier version of this implemented "Pull PI Planned" as a separate PI-level URL + a recursive `UNDER` WIQL query across the whole PI node. That was reworked after feedback — the PI's sprints are already each scoped to their own iteration path during PI planning, so the simpler "same per-sprint URL, pulled at an earlier point in time" model is both correct and far less code.)*

**Parent/Feature fetch** (`main.js`): `getWorkItemsBatch()` now requests `$expand=relations` instead of a `fields=` list (the two are mutually exclusive on this TFS REST endpoint), so every returned work item carries its link relations. `extractParentId(rawItem)` finds the `System.LinkTypes.Hierarchy-Reverse` relation and reads the parent's id off the end of its `url`. Parent ids collected across a pull's items are then batch-fetched again via `getParentsInfo()` (lightweight: just `System.Title`/`System.WorkItemType`, no relations) to build an `{id: {title, type}}` map. `classifyItems()` attaches `parentId`/`parentTitle` to every item it returns (both `null` when TFS reports no parent).

**Grouped-by-Feature item tables**: `tfsItemsTable(items, linkBase)` groups items by `parentId` first (sorted by id, with "(No parent feature)" last for anything without one). A pull's items with no `parentId` (e.g. anything pulled before this change, from an old save) land in one "(No parent feature)" group rather than being dropped or breaking.

**Final layout — a single Feature × Dev/QA/Team matrix table** (after readability feedback drove several iterations): one row per Feature, one column per Dev/QA/Team bucket, each cell holding that bucket's items for that Feature. Replaced two earlier designs — a flat grouped list, then a summary table + collapsible-`<details>`-per-feature breakdown — both of which turned out to depend on the TFS wiki's auto-expand mention behaving consistently across different Markdown contexts (table cell vs `<summary>` line vs plain bullet), which it didn't (see §6f below for exactly what broke and where). The matrix table instead types everything out directly — title, state badge, SP, tag-mismatch controls — with no dependency on auto-expand or collapsing anywhere, in either output format. `featureBucketSums(g)` (Dev/QA/Team SP sums for one group, counted items only) is shared between the Feature cell's total and (in the Markdown version) nothing else now needs it independently. `tfsItemRow()` lost its `showBucket` param (no longer meaningful — which bucket an item's in is now conveyed by which *column* it's in, not a per-row label).

**Two diff/churn comparisons, not one**: `tfsDiffSection(it, fromKey, toKey, label, diffKey)` (generalized from a hardcoded Planned-vs-Executed-only version) now renders an expandable "▸ Compare" link in the Sprint Actuals row for **both** `PI Planned vs Sprint Planned` (`diffKey:'diff-pi'`, shown once both `tfsPIPlanned` and `tfsPlanned` exist — scope drift between PI planning and this sprint's own planning) and the existing `Planned vs Executed` (`diffKey:'diff'`). Each has its own independent expand/collapse state in `_tfsDetailsOpen`. The Sprint Report panel's printable version mirrors this with two numeric-only stat sections (no expand/collapse, since the report is meant to be static/printable) via a shared `churnRow(fromItems, toItems)` helper in `buildSprintReviewSections()` — "PI Planned vs Sprint Planned" → **Drift** %, "Planned vs Executed" → **Churn** % (same union-based bounded formula for both).

**Sprint Report additions**: `buildSprintReviewSections(it)`'s `planning` group now reads Team → Capacity → Time Off → **PI Planned** (stats) → Planned (stats) → **PI Planned vs Sprint Planned** (drift stats); `review` is unchanged (Executed stats → Planned vs Executed churn stats). All three consumers (`showSprintReviewPanel()`, `buildSprintReviewText()`, `buildSprintReviewExportHtml()`) also add a **Work Items — PI Planned** table (from `it.tfsPIPlanned.items`, same grouped-by-Feature component), ordered before Work Items — Planned, preserving pull-chronological order.

**4-series report chart**: `buildReportChartSvg(cap, piPlanned, planned, executed)` gained a 4th series — grouped bars per Dev/QA/Team are now Capacity (grey) → PI Planned (blue) → Planned (amber) → Executed (purple), instead of 3. Any series that's `null` for a category (nothing pulled, or Team has no capacity) is simply skipped in that group.

**SP planned line on the Capacity overview chart**: `renderCapacityChart()` already plotted a dashed amber "SP est." line (modeled, hours × ratio) and a solid purple "SP Sprint Exec." line (from each sprint's `tfsExecuted`). It now also plots a solid green "SP Sprint Planned (TFS)" line + square markers from each sprint's own `tfsPlanned.totalSP` (the sprint-planning-time pull, not PI Planned) — the actually-pulled planned figure, distinct from the modeled estimate. All three lines get small x-offsets (`estOff`/`plannedOff`/`execOff`) so their point labels never overlap when two or three are present for the same sprint.

**Terminology**: once PI Planned existed alongside the original Planned/Executed, those two became ambiguous ("Planned" — which one?). Every user-facing label was renamed to **Sprint Planned** / **Sprint Executed** (buttons, breakdown lines, Sprint Report headings/chart legends, diff labels, tooltips) — **PI Planned** is unchanged. Internal field names were deliberately left alone (`it.tfsPlanned`/`it.tfsExecuted`/`it.tfsPIPlanned`, `mode: 'planned'|'executed'|'piplanned'`) — renaming those would be pure migration risk for zero user-facing benefit, since only the display text was ever confusing.

Key functions added/changed: `extractParentId(rawItem)`, `getParentsInfo()` (main process); `pullTfsSprint()` gained the `'piplanned'` mode, `clearTfsPull()` gained a `'piplanned'` branch, `tfsDiffSection(it, fromKey, toKey, label, diffKey)` generalized from `tfsDiffSection(it)`, `churnRow(fromItems, toItems)` (top-level, shared with §6f's `buildWikiMarkdown()`), `groupItemsByFeature(items)` (extracted out of `tfsItemsTable()`, also shared with §6f) (renderer).

---

## 6f. Publish Sprint Report to TFS Wiki

Each PI gets its own `pi.wikiUrl` (pasted TFS wiki **page** URL, e.g. `.../_wiki/wikis/System%20Manager/9699/PI-20` — a page the user already created by hand for that PI), set via a one-line input above Sprint Actuals (`#pi-wiki-url-wrap`, `renderPIWikiUrl()`, `updatePIField()`). Publishing happens per-sprint, from the Sprint Report modal.

**URL parsing** (`main.js`, `extractWikiPathInfo(wikiUrl)`): mirrors `extractIterationPath()`'s security model exactly — only the path *after* `_wiki/wikis/` is taken from the pasted URL (segment 0 = wiki name, the **last** segment = the page's display slug, e.g. `PI-20`; the middle numeric segment is parsed out but intentionally unused — see below). The actual HTTP request always targets the **configured** `tfsCollectionUrl`/`tfsProject`, never a host parsed from the pasted URL.

**Why the page's real path is matched by slug, not addressed by id or parsed literally from the URL** — two dead ends ruled out by trial against this actual on-prem server, in order:
1. The URL's middle numeric segment (e.g. `9699`) looks like a page id, and on Azure DevOps Services there's a "get page by id" route (`GET .../pages/{id}`) for exactly this. This on-prem server doesn't recognize that route at `api-version=5.0` though — it falls through to the path-based "get page" route and tries (and fails) to find a page literally named `/{id}`, producing a misleading "path of the page is incorrect" error for what's actually an unsupported-route problem.
2. Falling back to "fetch the whole page tree and match by `id`" doesn't work either — confirmed by reading the actual tree response: at this API version, a `WikiPage` object has no `id` property **at all** (its keys are `path`, `order`, `isParentPage`, `gitItemPath`, `subPages`, `url`, `remoteUrl`, `content`). There is no id to match against, however it's fetched.
3. The URL's trailing segment (e.g. `PI-20`) also isn't the page's real path — that's TFS's URL-safe *slug* (spaces become hyphens there), not the actual page path the REST API expects (a page titled "PI 20" has `path: "/PI 20"`, with a space, however deep it's nested — e.g. `/safe/2026/PI 20`). Treating the slug as a literal path 404s when creating a child under it ("ancestor page does not exist"), since no page is actually named the hyphenated form.

So `findWikiPagePathBySlug(collectionUrl, project, pat, wikiName, pageSlug, branch)` fetches the entire page tree (`GET .../pages?path=/&recursionLevel=Full` — the same path-based route we already know this server supports) and walks it (each node's `subPages` holds its children, recursively) comparing `slugify(lastPathSegment(node.path))` against `slugify(pageSlug)` (`slugify()`: lowercase + spaces→hyphens — the one TFS substitution rule actually observed, not a guaranteed-exact reverse of whatever TFS's real algorithm is, but good enough to match the real page regardless of how deep it's nested in the tree).

**Create-or-update** (`main.js`, `publishWikiPage(collectionUrl, project, pat, wikiName, pagePath, content, branch)`): GETs the target page path first to pick up its current `ETag` (needed as an `If-Match` header on the PUT that updates it — a 404 here just means the page doesn't exist yet, so the following PUT creates it with no `If-Match`), then PUTs `{content}` (Markdown) to the same path. `ipcMain.handle('tfs:publishWikiPage', ...)` wraps this: takes `{wikiUrl, subPath, content}`, builds the full page path as `{basePagePath}/{subPath}` (e.g. `/PI-20/Sprint 20.1`), and never throws across the IPC boundary (same `{ok, error}` pattern as `tfs:fetchSprint`). Any non-ok response's JSON body is parsed for a `message` field and appended to the thrown error (`tfsErrorDetail(resp)`) — a plain `400 Bad Request` with no detail is useless for diagnosing which part of the request TFS rejected.

**Wiki branch**: a project wiki is git-backed under the hood, and at least one on-prem TFS setup we've hit can't infer that backing branch automatically — every wiki page PUT 400s with `"The versionType should be 'branch' and version cannot not be null"` until `versionDescriptor.versionType=branch`/`versionDescriptor.version={branch}` are passed explicitly as query params. Added an optional **Wiki branch** field to TFS Settings (`tfsWikiBranch` in `config.json`, plaintext like `tfsCollectionUrl`/`tfsProject` — not a secret) — when set, `publishWikiPage()` appends those two params to both the GET and PUT; left blank (the default), the query string is unchanged from before, so instances where branch inference already works are unaffected.

**Choosing what to publish**: the Sprint Report modal grows a row of checkboxes — one per pulled snapshot (**PI Planned** / **Sprint Planned** / **Sprint Executed**, only shown for whichever ones actually exist, all checked by default) — plus a "📤 Publish" button (disabled with a tooltip when `pi.wikiUrl` is empty). **Republishing is a full overwrite, not an accumulating history**: whatever's checked at publish time becomes the page's entire content, replacing what was there before — confirmed behavior, not a choice to merge/append. A diff/comparison section (PI Planned vs Sprint Planned "Drift", Sprint Planned vs Sprint Executed "Churn") only appears in the published content when **both** of its two inputs are checked, consistent with "exactly what's checked, nothing implied."

**Markdown content** (`buildWikiMarkdown(it, selected, linkBase)`): same shape as the Sprint Report (Team → Capacity → Time Off, then each selected pull's stats + Work Items, then the drift/churn comparisons that qualify) but as Markdown. Team/Time Off always appear (they aren't gated by the PI Planned/Sprint Planned/Sprint Executed checkboxes — that selection only controls which *pulls* show up) and are built by the same `buildTeamSection(it)`/`buildTimeOffSection(it)` helpers the live Sprint Report uses, extracted out of `buildSprintReviewSections()` specifically so the two outputs can never disagree on who was on the sprint or who took time off. `linkBase` is fetched once via `tfs:getSettings` inside `publishSprintReviewToWiki()` (same `{collectionUrl}/{project}/_workitems/edit/` shape the HTML export already builds) and threaded down to `mdItemsList()` so item/Feature references can be real Markdown links instead of plain text.

**Side-by-side summary cards on the wiki** (user request, to cut scrolling): the small summary tables are laid out like the app's cards, via `htmlCardRow(cards)`. Row 1 is Team | Capacity | Time Off. Row 2 holds one totals card per selected pull, in timeline order, with each comparison card (Drift/Churn) right after the two pulls it compares. The wide Work Items tables follow below, one per pull. Markdown can't place tables side by side, so these rows are raw HTML: an outer one-row `<table>` with an `<h2>` and an inner HTML `<table>` per cell. Markdown isn't parsed inside an HTML block, which is why the inner tables are HTML too. The block also has no blank lines, because a blank line ends an HTML block. Values go through `esc()`.

**Why the Work Items table abandoned the TFS wiki's auto-expand mention entirely** (after several rounds of readability feedback and real-published-page testing): a bare `#12345` (not wrapped in other Markdown) gets auto-expanded by the TFS wiki into a rich reference card — icon, title, type, state. That looked promising, but turned out to behave inconsistently depending on exactly where the bare reference sat, each inconsistency only found by publishing and reading the actual result:
- Typing the title next to a bare `#id` duplicates what the wiki's own card already renders (the first thing found — every item showed up twice).
- A bare `#id` **inside a Markdown table cell** does trigger the card — but a *separate*, unrelated bug (an unescaped literal `|` in this team's Feature-title convention, e.g. "Achieve QG4 Release Approval | System Manager 3.1.0", splitting the table row) was initially misdiagnosed as an auto-expand/table-cell conflict. It wasn't; pipes break tables regardless of what's inside the cell. (`mdEscapeCell(s)`, still used by `mdTable()`'s label/value rows, was the real fix for that specific bug.)
- A bare `#id` **inside a `<summary>` line**, however, does *not* get the card — confirmed from a real published page: items nested inside an expanded `<details>` still showed their full card, but the `<summary>` line itself only ever rendered a bare `#id — N SP`, no title or state.
- `<details>/<summary>` itself *does* actually toggle on this wiki (an earlier pass wrongly concluded otherwise, from seeing only the closed-state triangle — which looks identical to a correctly-working `<details>` nobody's clicked yet).

Chasing each of these down (per-context escaping rules, a separate typed form for `<summary>` only, etc.) made the whole thing fragile to reason about and kept surfacing new edge cases on every real publish. **Replaced** with a single flat matrix table, same shape as the HTML version (see above): `mdItemsList(items)` builds one Markdown table row per Feature, one column per Dev/QA/Team. Multiple items in one cell are joined with literal `<br>` tags — Markdown table rows must be a single source line, so an actual newline would break out of the row; `<br>` is plain HTML embedded in the cell, rendered as a line break without touching the table structure.

**Markdown references are bare `#id`, with whitespace on both sides** (user's explicit preference: the wiki should fill in each item's name and status itself). Each item is just `#{id}` (plus `_(not closed)_` / `**[check tag]**` flags when they apply), items in a cell are joined with `' <br> '`, and the Feature cell is just `#{id}` — no SP per item or per Feature (removed by request; the pull's own stats table above already gives the SP totals). The spaces around `<br>` matter: a published page where `<br>` touched an id directly (`#507528<br>…`, `…<br>#507825`) left exactly those ids as plain text; with whitespace on both sides, every id expanded (confirmed by a real publish). All section headings are `#` (Team, Capacity, Time Off, each pull, "Work Items — …", the comparisons) — bigger than before, by request, since `##`/`###` rendered too small on this wiki. A fully typed-out version (`[{state}] [#{id} {title}](link) — {sp} SP`, with `linkBase` from `tfs:getSettings`) was used briefly in between and rendered correctly, but without the wiki's icons/status badges — it's the fallback if bare ids stop working. The **HTML** version is unaffected — `tfsItemsTable()` always types everything out, since the Electron window has no auto-expand.

Fetching a Feature's own state (`g.state` on each `groupItemsByFeature()` group) was added along the way and is still needed: `main.js`'s `getParentsInfo()` now asks for `System.State` alongside `System.Title`/`System.WorkItemType`, carried through as `parentState` on each item (`classifyItems()`). The HTML version picked up the same data for free — `tfsItemsTable()`'s Feature cell shows `stateBadge(g.state)` next to the title, where previously the live app showed no Feature-level state at all.

Key functions added: `extractWikiPathInfo(wikiUrl)`, `findWikiPagePathBySlug()`, `slugify()`, `lastPathSegment()`, `publishWikiPage()`, `tfsErrorDetail(resp)` (main process); `featureBucketSums(g)` (shared by `tfsItemsTable()` and `mdItemsList()`), `mdEscapeCell(s)` (used by `mdTable()`, and by `mdItemsList()` for the "(No parent feature)" label); `tfs:publishWikiPage` exposed as `publishWikiPage` (preload.js); `updatePIField(piId, field, value)`, `renderPIWikiUrl()`, `mdTable(rows)`, `mdItemsList(items)`, `buildWikiMarkdown(it, selected)`, `publishSprintReviewToWiki()` (renderer).

**Epic column (sprint work items tables)**: Features are grouped by their parent Epic — the sprint pull (`tfs:fetchSprint`) now goes two levels up: each item's parent Feature is fetched with relations (`getWorkItemsBatch`), then the Features' parents (Epics) via `getParentsInfo`; `classifyItems()` adds `parentEpicId/parentEpicTitle/parentEpicState` to every item (pulls made before this have none → "No Epic" until re-pulled). `groupItemsByFeature()` sorts groups by Epic id, then Feature id (no-Epic Features after all Epics, items without a parent Feature last), and `epicRuns()` collapses consecutive groups sharing an Epic. `tfsItemsTable()` adds a first **Epic** column with one `rowspan` cell per run (link + title + state badge); `mdItemsList()` adds the same column on the wiki, but since Markdown can't merge cells the Epic's bare `#id` is on the run's first row only, blank below.

**Manual priority order (▲▼)**: the user wanted to choose what appears top to bottom (using TFS's backlog rank or Priority field was offered; they chose manual). One order **per PI**, shared by every sprint's tables, the PI Roadmap list and both wiki pages: `pi.order = { epics: [id…], features: [id…] }`. `orderComparators(order)` sorts ranked ids by list position, unranked ones after by id, and a missing Epic / parent Feature (null) always last; used by `groupItemsByFeature(items, order)` (defaults to the viewed PI's order) and `groupFeaturesByEpic(features, order)`. `rankArrows(kind, id, visibleIds, target)` renders ▲▼ (Epics among Epics, Features only within their Epic); `moveRank()` first appends any visible-but-unranked ids to the list in display order (which is where they were already displayed), then swaps with the displayed neighbour — so a move always matches what the user sees and ids not on screen keep their positions. Arrows only appear in the editable Sprint Report modal and the PI Roadmap list (not the PDF export or Sprint Actuals' "View items"); the roadmap lists' `<details>` open state is kept in `_roadmapOpen` so a ▲▼ re-render doesn't collapse them.

**App-wide sizing for big screens**: the page width is the CSS variable `--page-max: max(1280px, 94vw)` (header, `.page`, PI switcher, summary bar, PI panel — all used to be a fixed 1280px/1200px). App zoom is Electron's real page zoom, owned by `main.js`: `setAppZoom(webContents, z)` (clamped 0.7–2.0) applies it, saves `appZoom` in `config.json` and sends `app:zoomChanged` to the renderer (which updates the header's `− 100% +` label); it's restored on every `did-finish-load`. Header buttons call `app:changeZoom(delta)` (0 = reset); **Ctrl + / Ctrl − / Ctrl 0** are intercepted in `before-input-event` and routed through the same function, so the keyboard and buttons share one saved value (the hidden default menu's zoom accelerators would otherwise change it unsaved). **Esc** closes any open `.history-overlay` popup, and the Sprint Report header has a **✕ Close** button (no scrolling to the bottom to close).

**Sprint Report sizing for big screens** (user presents on a 4K display): the modal (`#sprint-review-box`) is `96vw` wide (no fixed max — it used to stop at 1400px), plus header buttons **A− / A+** (`adjustSprintReviewZoom()`, CSS `zoom` 0.7–2.0 on the `#sprint-review-content` wrapper, which re-flows the content to the popup width rather than overflowing) and **⛶ Full screen** (`toggleSprintReviewFull()`, 100vw × 100vh, `border-box`). Both are a per-viewer convenience, kept in `localStorage['sprintReviewView']` (try/catch) and applied on every open by `applySprintReviewView()`.

**Epic priority labels (High / Mid / Low)**: like the Priority column on the team's hand-written PI pages. One set per PI, shared like the ▲▼ order: `pi.epicPriority = { epicId: 'High'|'Mid'|'Low' }`. A label only — it doesn't affect ordering, which stays manual. Set via `prioritySelect()` (a dropdown on each Epic in the Sprint Report modal's Epic cell and on each Epic header in the PI Roadmap list) → `setEpicPriority()`; shown as `priorityBadge()` (colored dot + HIGH/MID/LOW) in the PDF export. On the wiki it's a separate first **Priority** column (`priorityMd()`: 🔴 HIGH / 🟠 MID / 🟡 LOW), in both the sprint table (`mdItemsList()`, on each Epic run's first row) and the PI summary (`mdEpicsTable()`) — kept out of the Epic cell so the Epic's bare `#id` stays alone in its cell and still expands into the wiki's card.

**Re-pulls never lose comments or topics**: `it.comments` / `it.topics` are stored apart from the pulled snapshots (`it.tfsPIPlanned/tfsPlanned/tfsExecuted`), keyed by Feature id, so `pullTfsSprint()` replacing a snapshot never touches them — only the user deletes them. Before replacing a snapshot, `pullTfsSprint()` records each commented Feature's current title on its comment (`c.title`), so if a Feature drops out of the new pull (removed from the sprint / deleted in TFS) its comment can still say what it was about. `orphanCommentKeys(it, mode)` finds comments with text whose Feature isn't in the current snapshot; the pull's toast warns about them, `orphanRows()` lists them at the bottom of the Sprint Report table (red, "⚠ No longer in this pull", the Feature's id + last-known title, comment still editable, "🗑 Delete comment" → `deleteFeatureComment()` with a confirm). They're not published to the wiki (the Feature isn't in the sprint any more); the publish toast says how many were held back. `updateFeatureComment()` merges into the stored comment rather than replacing it, so editing text keeps `title`.

**New-topic placeholder rows**: for ideas raised while presenting to stakeholders that aren't in the TFS backlog yet. Per iteration, per pull (like comments): `it.topics[mode] = [{ id, title, dev, qa, team, comment }]`, all free text. `tfsItemsTable()` appends them after the TFS rows via `topicRows()` (amber background, "📝 New topic — not in backlog yet" in the Epic column; textareas + "✕ Remove" when editable, read-only text in the PDF export) and adds a "+ Add new topic" button under the editable table. `addTopic()`/`removeTopic()` re-render the modal; `updateTopic()` doesn't (keeps textarea focus). On the wiki `mdItemsList(items, comments, topics)` appends them after the TFS rows as `|  | 📝 _New topic_ | **title** _(not in backlog yet)_ | dev | qa | team | comment |`; completely empty topics aren't published. Workflow: once the topic exists in TFS, re-pull (the real Feature appears as a normal row) and remove the placeholder by hand — nothing is matched automatically. `mdFreeText(text)` (shared with Comments) does the cell escaping, newline → `' <br> '` and URL → `🔗 link` conversion.

**Per-feature Comments (sprint work items tables)**: a 5th "Comments" column, one comment per Feature row, **separate per pull** (planning notes on Sprint Planned, review/demo notes on Sprint Executed): `it.comments[mode][featureKey] = { text }` with `mode` = `piplanned|planned|executed` and `featureKey(g)` = the Feature id or `'none'`. **Free text only**: an earlier version also uploaded images/videos to the wiki as attachments, but TFS caps attachments at ~19 MB (a real 57 MB demo video hit it), so the user chose to host images and videos on SharePoint/Teams and paste the link into the comment instead — attachment upload for comments was removed (auto-compressing with a bundled ffmpeg was offered and declined). `tfsItemsTable(items, linkBase, commentsCtx)` adds the column only when `commentsCtx = {it, mode, editable}` is passed — the Sprint Report modal passes `editable: true` (a textarea), the PDF/image export passes `editable: false` (read-only text), Sprint Actuals' "View items" passes nothing. Typing saves without re-rendering (`updateFeatureComment()`, keeps textarea focus). `mdItemsList(items, comments)` always includes the Comments column on the wiki, empty where a row has no text (pipes escaped, newlines → `' <br> '`) — it was briefly added only when some row had text, which made the column vanish whenever the published pull's comments were all blank. In the wiki cell, every `http(s)://…` URL in the comment text becomes a short `[🔗 link](url)` (`|` and `)` percent-encoded inside the URL so they can't break the cell or the link) — SharePoint URLs are long enough to otherwise stretch the column.

---

## 6g. PI Roadmap pull (Features on the Delivery Plan) and PI wiki summary

**Step 2 — PI summary publish, grouped by Epic** (built after the pull was confirmed against the real server — 19 features, including 8 assigned to PI19 iterations whose plan bars run into PI 20's dates; kept, since they're on the plan). A first version used hand-written goals (text + notes, a goal picker per feature); the user found it confusing and asked to keep it simple: **each row is the Feature's parent Epic**, its Features as the Items. `tfs:fetchRoadmap` now returns `epicId`/`epicTitle` per Feature (parent via `extractParentId()` + `getParentsInfo()`, same as the sprint pull's parent Feature); pulls made before this have no `epicId` and land in "No Epic" until re-pulled. Per PI, only `planningMeetings` (free text) is hand-entered. UI in the PI Roadmap block: each pull's feature list grouped under its Epic (`groupFeaturesByEpic()`), a Planning meetings input, and a "Publish PI summary to Wiki" row with PI Planned / PI Executed checkboxes. `buildPIWikiMarkdown(pi, selected)` mirrors the team's hand-written PI page: **Planning** (start/end from `piDateRange()`, planning meetings), **Iterations** (label, start, end), **PI Planned / PI Executed** (`mdEpicsTable()`: `| Epic | Features |`, Epic and Features all bare `#id`s joined `' <br> '`, a final "No Epic" row), and **PI Planned vs PI Executed** (planned features closed X of N, added/removed ids) when both are selected. **Delivery Plan screenshots** (the user used to paste one per pull into past PI pages): each pull line has "🖼 Attach plan screenshot" → `tfs:attachWikiImage({wikiUrl, baseName})` (`main.js`) opens a file picker and uploads the image as a **wiki attachment** (`PUT _apis/wiki/wikis/{wiki}/attachments?name=…&api-version=5.0`, base64 body, plus `versionDescriptor` when a wiki branch is configured), returning its `/.attachments/…` path. Only that path is stored (`pi.roadmapImages[mode] = {path, fileName}`) — not the image — so the save file and its localStorage mirror stay small, and the PI Planned screenshot uploaded at PI start is still there to embed when PI Executed is published months later. `buildPIWikiMarkdown()` embeds it under the matching pull as `## Delivery Plan — {label}` + `![…](path)`. Removing it in the app only stops embedding it; the attachment stays in the wiki. Upload not yet verified against the real server. `publishPISummaryToWiki()` publishes to the PI's own wiki page (`subPath: ''` — `tfs:publishWikiPage` now treats an empty subPath as "the page itself"), after a confirm, since it replaces that page's entire content.

**Step 1 — the pull:**

Goal (user request): a PI-level summary on the PI's own wiki page, like their hand-written PI 18 page (Planning dates, Iterations, Goals with their Features, Notes), pulled at PI planning ("PI Planned") and again at PI end ("PI Executed"), with a comparison — the PI-level equivalent of the sprint reports. **Source of Features is the PI's Delivery Plan only** (the user curates their PI roadmap there), never the sprints. **Goals are manual** (typed in the app, with Features assigned to each) — they do not map to Epics. This step only implements the pull, to confirm the Delivery Plan API works on this on-prem server before building goals and the wiki page on top of it.

**Data**: per PI, `roadmapUrl` (pasted link), `roadmapPlanned` / `roadmapExecuted` — each `{ source: 'plan'|'query', features: [{id, title, state, iterationPath}], pulledAt }`. UI: a "PI Roadmap" block below Wiki Publishing (`#pi-roadmap-wrap`, `renderPIRoadmap()`, called from `recalc()`), with Pull PI Planned / Pull PI Executed buttons, a collapsible feature list per pull, and an added/removed count once both exist.

**`tfs:fetchRoadmap({url, startDate, endDate})`** (`main.js`): `extractRoadmapSource(url)` takes only the GUID from the pasted link (same security model as `extractIterationPath()`) and accepts either a Delivery Plan URL (`_deliveryplans/plan/{guid}`) or a saved query URL (`_queries/query/{guid}`) — the query is the fallback the user offered if the plan API isn't available. Plans: `GET _apis/work/plans/{id}/deliverytimeline?startDate&endDate&api-version=5.0-preview.1` over the PI's date range (`piDateRange(pi)`) — confirmed supported by this server, but it rejects any window of 65+ days (`VS403164`), so `fetchDeliveryPlanIds()` walks the PI in ≤60-day windows and unions the ids; `collectTimelineIds()` takes only `System.Id` from each team/iteration row (rows are value arrays ordered by `fieldReferenceNames`; `partiallyPaged*` rows are included too). Queries: `GET _apis/wit/wiql/{id}` (flat `workItems` or tree `workItemRelations`). Either way, details come from the existing `getWorkItemsBatch()` and are filtered to `WorkItemType === 'Feature'`. **Not yet verified against the real server** — the deliverytimeline API version in particular is a guess.

---

## 6b. UX Enhancements (added June 2026)

### Always-visible summary bar (`#pi-summary-bar`)
- Sticky bar (`position:sticky;top:0`) below the PI switcher, dark navy background
- Shows DEV h, DEV SP, QA h, QA SP, Total SP for the viewed PI
- Hidden when no iterations exist
- Updated by `recalc()` after every calculation

### Save toast
- `showToast(msg, type)` — creates a brief bottom-right notification
- Called from `manualSave()` on success ('✓ Saved — filename') and failure
- Types: `toast-success` (dark green) and `toast-error` (dark red)

### Section collapse animation
- `toggleSection(header)` now animates `max-height` + `opacity` using inline style transitions
- Opening: adds `.open` class immediately, animates from `max-height:0` to `scrollHeight`
- Closing: animates to `max-height:0`, then removes `.open` class on `transitionend`
- Initial state (from `restoreSectionState()`) still uses direct class toggle without animation

### Capacity utilisation colour coding
- Each capacity table row gets a coloured dot: green (≥90%), amber (75–90%), red (<75%)
- Utilisation = actual focus hours / baseline (all members × sprint days, no leave)
- Amber/red rows also get a tinted background and left border

### Member cards
- Team members rendered as `.member-card` divs in a grid (`repeat(auto-fill, minmax(320px, 1fr))`)
- Container `id="team-tbody"` is now a `<div class="member-cards-grid">` (not a `<tbody>`)
- Role selector styled as a badge; name is an inline editable input; focus % shown with h/day
- Notes field at the bottom of each card (same data model as before)

### Capacity chart
- `renderCapacityChart(iters, devHArr, qaHArr)` — SVG stacked bar chart
- DEV (blue) at bottom, QA (teal) on top; total hours label above each bar
- Responsive via `viewBox="0 0 800 …"` with `width:100%` CSS
- Displayed in `#cap-chart-wrap` inside the Capacity section, above Sprint Actuals

## 7. Key Functions Reference

| Function | What it does |
|---|---|
| `recalc()` | Main calculation engine. Recomputes all capacity numbers and re-renders: capacity table (with colour coding), summary bar, SVG chart, cards, member hours grid, historical section, ratio suggestion, sprint actuals |
| `renderAll()` | Full re-render: PI management + team table + overhead + time-off section + recalc() |
| `memberFocusInIteration(m, it)` | Returns focus hours for member `m` in iteration `it` |
| `memberBaselineFocus(m)` | Returns focus hours for a standard 15-day sprint with no time off |
| `focusStd()` | Returns `FULL_H - totalOverhead()` |
| `totalOverhead()` | Sum of all `overhead[i].hpd` |
| `scheduleSave()` | Marks unsaved status, silently saves to localStorage, and (re)starts the ~1.2s debounce timer that calls `autoSaveToFile()`. |
| `autoSaveToFile()` | Debounced auto-save target — calls `safeWriteFile()` once edits settle. |
| `newestState(...candidates)` | Returns whichever of the given state objects (primary file / backup mirror / localStorage) has the most recent `savedAt`. |
| `checkBackupForUpdate()` | Polled every `BACKUP_POLL_MS` (and on window focus) — pulls a newer backup-mirror save into the local primary file automatically, skipped while local edits are pending. |
| `manualSave()` | Cancels the pending debounce and writes immediately via `safeWriteFile()`. Called by Save button or Ctrl+S. |
| `applyState(data)` | Loads a saved state object. Includes backfill logic for older saves. Does NOT touch `viewedPIId` — caller is responsible for setting it. |
| `initViewedPI()` | Sets `viewedPIId` to the 'current' PI (or null). Called only from `initStorage()` so that reconnect/reload mid-session does not jump tabs. |
| `renderTeam()` | Re-renders the team member cards. Called after role/overhead changes (since % column depends on focusStd). |
| `renderOverhead()` | Re-renders the ceremony table. Also calls renderTeam() to refresh % column. |
| `toggleSection(header)` | Collapse/expand a section with animated max-height transition. Persists state to localStorage. |
| `showToast(msg, type)` | Shows a brief bottom-right notification. type: 'success' or 'error'. |
| `renderCapacityChart(iters, devHArr, qaHArr)` | Renders SVG stacked bar chart into `#cap-chart-wrap`. |
| `setPIStatus(piId, status)` | Unified status dispatcher — routes to `setCurrentPI`, `markAsCurrent`, `markHistorical`, or `markFuture`. Called by the status dropdown in PI Management. |
| `markHistorical(piId)` | Marks a PI historical. Only ensures `pi.actual` exists as a fallback shell — `effectiveActual()` computes the real hours/SP live, so there's nothing to snapshot. |
| `effectiveActual(pi)` | The source of truth for "what happened" in any PI with an `actual` record. Computes `devH`/`qaH`/`devSPest`/`qaSPest` live via `projForPI(pi)` whenever the PI has team+iteration data (so it's never stale), and sums `devSPexec`/`qaSPexec` live from each iteration's Sprint Actuals. Falls back to the stored `pi.actual` fields only for PIs with no team/iteration data at all. Used by the Historical Comparison card, `piHours()`/`piTotalSP()` (Δ-vs-previous-PI), and `computeActualRatios()`/`getSuggestedRatios()`. |
| `setCurrentPI(piId)` | Marks `piId` as `'planning'`. Uses `inferStatusFromDates(prev)` to decide prev PI's new status; aggregates actuals if prev is historical. Resets `viewedPIId = null`. |
| `markAsCurrent(piId)` | Marks a PI as `'current'` (running). Demotes any existing 'current' PI. |
| `renderAll()` | Syncs `team` to viewed PI's team at the top before re-rendering everything. |
| `getViewedPI()` | Returns the PI currently being viewed in sections 2–5. Falls back to `getCurrentPI()` when `viewedPIId` is null. |
| `getViewedIterations()` | Returns iterations for the viewed PI. |
| `setViewedPI(id)` | Sets `viewedPIId` and re-renders affected sections. Called by PI tab switcher. |
| `renderPISwitcher()` | Renders the tab strip (shown when ≥2 PIs exist) and the amber "Viewing PI X" notice banner. |

---

## 8. Constants

```javascript
const FULL_H = 8;   // standard full working day hours (baseline for focusStd calculation)
const DAYS   = 15;  // default sprint working days
```

---

## 9. Backfill / Migration Logic

`applyState()` backfills missing fields for backward compatibility with older saves:

```javascript
// Per iteration:
if (!it.holidays)          it.holidays  = [];
if (!('devSPexec' in it))  it.devSPexec = null;
if (!('qaSPexec'  in it))  it.qaSPexec  = null;
if (!('dateStart' in it))  it.dateStart = '';
if (!('dateEnd'   in it))  it.dateEnd   = '';
if (!('days'      in it))  it.days      = DAYS;
if (!('tfsUrl'        in it))  it.tfsUrl        = '';
if (!('tfsPIPlanned'  in it))  it.tfsPIPlanned  = null;
if (!('tfsPlanned'    in it))  it.tfsPlanned    = null;
if (!('tfsExecuted'   in it))  it.tfsExecuted   = null;

// Per PI (see §6f):
if (!('wikiUrl' in pi))  pi.wikiUrl = '';

// Per team member:
if (!m.daysOff)            m.daysOff    = {};
if (!('focusHpd' in m))    m.focusHpd   = +((m.avail||100)/100 * focusStd()).toFixed(2);
// ↑ migrates old 'avail' percent field to the new 'focusHpd' direct hours field
```

---

## 10. Focus h/day ↔ % Two-Way Input

The team table has two linked inputs per row:
- **h/day input** (`inp-hpd-{i}`): stores `m.focusHpd` directly
- **% input** (`inp-pct-{i}`): bidirectional, where `% = (focusHpd / focusStd()) * 100`

**Key precision rule**: When converting `%` → `focusHpd`, the full float is stored (not rounded). The h/day input is shown rounded to 2dp for display only. This ensures the `%` round-trips correctly: entering `80%` always shows back as `80.0%`.

---

## 11. Design Decisions & Why

| Decision | Reason |
|---|---|
| Single HTML file for the UI | Zero build step, easy to read/edit, works offline |
| Electron wrapper instead of browser File System Access API | Chrome blocks write permission to network-share files via that API, full stop — Node `fs` in Electron's main process has no such restriction |
| Local primary + optional mirrored backup path (not a single shared file) | Single-user app now; local write always succeeds even if the network share is briefly unreachable, and the mirror keeps a team-visible backup copy |
| Auto-save to file, debounced ~1.2s | Nobody should depend on remembering to click Save. Save/Ctrl+S still exists as a "force save now" action. |
| `focusHpd` as primary field (not avail%) | Matches Excel model; direct entry of "3.5h/day for devs" is more intuitive than computing avail% |
| focusStd() uses FULL_H=8 as baseline | Standard 8h day minus overhead = theoretical maximum focus for a full-time employee |
| No `avail` field stored | Replaced by `focusHpd`. The % displayed is always derived, never stored. |
| Overhead changes re-render team table | The % column depends on focusStd() which changes with overhead, so team table must refresh |
| localStorage as silent backup | Protects against losing data if the app closes before an auto-save fires |
| Section collapse state in separate localStorage key | Survives JSON file loads without being overwritten |
| `.exe` left unsigned (`signAndEditExecutable: false`) | Internal single-team tool — a paid code-signing cert (~70-500€/yr, OV/EV) isn't worth it just to silence the SmartScreen "unknown publisher" prompt; clicking "More info → Run anyway" once per machine is enough |
| Custom icon generated by `scripts/build-icon.js` instead of an external design tool | No image-editing tool available in this workflow; a small hand-rolled PNG/ICO encoder reliably reproduces a simple on-brand mark and can be re-run whenever the design changes |
| TFS PAT stored via `safeStorage` + dedicated `tfs:getSettings`/`tfs:setSettings` IPC channels, not the generic `config:get`/`config:set` | Those generic channels return the whole config object unredacted to the renderer — fine for file paths, not for a credential. `safeStorage` gives OS-level (DPAPI) encryption at rest with no new dependency; the PAT is decrypted only inside `main.js`, only at request time. |
| TFS "Team" bucket (untagged/both-tagged User Stories) kept informational-only, never folded into `devSPexec`/`qaSPexec` | Keeps the existing Dev/QA ratio-calibration math exactly as it was before this feature — a deliberate choice confirmed with the team, not an oversight. |
