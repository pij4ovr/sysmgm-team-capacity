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
| `main.js` | Electron main process. Creates the window, owns `config.json` (in `app.getPath('userData')`), and exposes IPC handlers: `config:get`, `config:set`, `dialog:pickOpen`, `dialog:pickSave`, `file:read`, `file:write`. |
| `preload.js` | Context-bridge: exposes a safe `window.electronAPI` (`getConfig`, `setConfig`, `pickOpenPath`, `pickSavePath`, `readFile`, `writeFile`) to the renderer. `contextIsolation: true`, `nodeIntegration: false`. |
| `package.json` | `npm start` → `electron .` (dev run). `npm run dist` → `electron-builder`, produces a portable `.exe` under `dist/` (Windows target, no installer required). |

To run: `npm install` once, then `npm start`. To produce a distributable: `npm run dist` (downloads Electron's prebuilt binaries on first run — needs internet access once).

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
        qaSPexec: null               // actual executed QA SP (null = not yet tracked)
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
    name: 'João Botelho',
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

Current team:
| Name | Role | focusHpd | Rationale |
|---|---|---|---|
| João Botelho | Dev | 3.5 h/day | Still learning, 6h contracted, 2.5h overhead = 3.5h focus |
| João Oliveira | Dev | 3.5 h/day | Same as above |
| João Pires | QA | 1.5 h/day | Hybrid QA+PO role, 4h contracted, 2.5h overhead = 1.5h focus |
| Wanderson Coelho | QA | 5.5 h/day | Full-speed, 8h contracted, 2.5h overhead = 5.5h focus |

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

## 11. PI 19 — Current Setup (as of June 2026)

| Iteration | Sprint | Dates | Working Days |
|---|---|---|---|
| 19.1 | 157 | 24 Jun → 14 Jul 2026 | 15 |
| 19.2 | 158 | 15 Jul → 4 Aug 2026 | 15 |
| 19.3 | 159 | 5 Aug → 25 Aug 2026 | 15 |
| 19.4 | 160 | 26 Aug → 15 Sep 2026 | 15 |
| 19.5 | 161 | 16 Sep → 6 Oct 2026 | 15 (3 public holidays → 12 net) |

Active iterations per member:
- João Botelho: all 5
- João Oliveira: 19.1, 19.2, 19.3
- João Pires: all 5
- Wanderson Coelho: all 5

---

## 12. Design Decisions & Why

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
