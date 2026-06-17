# Architecture Overview — Desktop App (Electron)

> Companion to `CONTEXT.md` (which covers the app's data model, formulas, and UI). This file focuses on **how the desktop app itself is put together and built** — useful if you're not familiar with Electron.

---

## 1. Why this app is an Electron app at all

The app used to be a single HTML file running directly in a browser, saving via the browser's File System Access API. That broke for one specific reason: **Chrome refuses to grant write access to files on a network share** (e.g. `\\10.135.2.100\SysMgm\...`), no matter what — confirmed via `SecurityError`, even on a real, immediate user click. It's a deliberate browser restriction, not a bug to work around.

Electron exists here to solve exactly that one problem: it gives the app a private Node.js runtime that can write files anywhere (local disk or network share) with no browser sandbox in the way. Nothing about the actual app logic (calculations, UI, data model) changed — it was wrapped, not rewritten.

---

## 2. The two-process model

Every Electron app is really **two separate JavaScript environments running side by side and talking to each other over a message channel (IPC)**:

```
┌───────────────────────────────┐          ┌────────────────────────────────────┐
│  Main process (main.js)        │          │  Renderer process                   │
│  = plain Node.js               │   IPC    │  = PI_SysMgm_Team_Capacity.html      │
│  Full OS access:                │◄────────►│  Runs inside a Chromium window       │
│   - creates the BrowserWindow   │          │  Sandboxed:                          │
│   - real fs.readFile/writeFile  │          │   - NO direct filesystem access      │
│   - native Open/Save dialogs    │          │   - NO direct Node.js access         │
│   - owns config.json            │          │  Just vanilla JS/DOM — your app's    │
│    (app.getPath('userData'))    │          │  actual logic, calculations, render  │
└───────────────────────────────┘          └────────────────────────────────────┘
                  ▲
                  │ exposes a safe, limited API
                  │
        ┌───────────────────┐
        │   preload.js        │
        │  contextBridge.      │
        │  exposeInMainWorld(   │
        │   'electronAPI', {…} )│
        └───────────────────┘
```

- **`main.js`** — the only place with real OS power. On startup it creates the app window and loads `PI_SysMgm_Team_Capacity.html` into it. It also registers IPC handlers (`ipcMain.handle(...)`) for everything that needs OS access:
  - `config:get` / `config:set` — read/write `config.json` (stores the user's chosen save-file paths)
  - `dialog:pickOpen` / `dialog:pickSave` — native Windows file picker dialogs
  - `file:read` / `file:write` — real `fs` calls to read/write the data file, anywhere on disk or a network path

- **The renderer (the HTML/JS app)** — your actual UI and logic. It is intentionally sandboxed:
  - `contextIsolation: true` — its JS world is isolated from Electron/Node internals
  - `nodeIntegration: false` — it cannot `require()` Node modules or touch the filesystem directly

  This is a deliberate security boundary: even if the page's JS had a bug or were compromised, it physically cannot reach the OS — it can only call the few functions explicitly exposed to it.

- **`preload.js`** — the bridge. It runs in a special privileged context with access to both worlds, and its only job is:
  ```js
  contextBridge.exposeInMainWorld('electronAPI', {
    getConfig, setConfig, pickOpenPath, pickSavePath, readFile, writeFile
  });
  ```
  This is *why* the HTML/JS code can call `window.electronAPI.writeFile(...)` even though it has no Node access — that call is forwarded over IPC to `main.js`, which performs the real file write and sends the result back.

### Example: what happens when you click "Save"
```
HTML (renderer)              preload.js bridge        main.js (Node)
─────────────────            ──────────────────       ────────────────
manualSave()
 → safeWriteFile()
 → window.electronAPI
     .writeFile(path, json) ──────────────►  ipcRenderer.invoke('file:write', …)
                                                         ──────────────►  ipcMain.handle('file:write', …)
                                                                            fs.mkdir + fs.writeFile (real OS write)
                              ◄──────────────  result { ok: true }   ◄──────────────
 ← { ok: true }
 showToast('✓ Saved')
```

---

## 3. What's *not* here

- No bundler, no Webpack/Vite, no React/Vue — `PI_SysMgm_Team_Capacity.html` is loaded as-is via `win.loadFile(...)`. It's the same vanilla-JS single-file app it always was.
- No server, no backend, no database. The "backend" is just `main.js`'s few IPC handlers wrapping plain `fs` calls.

---

## 4. How `npm run dist` produces the `.exe`

Build config lives in the `build` block of `package.json`. The script runs **electron-builder**:

1. **Fetch the runtime** — electron-builder uses a prebuilt Electron binary for Windows (Chromium + Node.js compiled together). First run needs internet access to download it; cached afterwards.
2. **Copy app files** — only the files listed under `build.files` are included: `main.js`, `preload.js`, `PI_SysMgm_Team_Capacity.html`.
3. **Assemble the app folder** — these are combined with the Electron runtime into `dist/win-unpacked/`:
   - `Team Capacity Calculator.exe` — the actual launcher
   - `resources/` — your app code lives here, bundled
   - everything else (`*.pak`, `*.dll`, `icudtl.dat`, `v8_context_snapshot.bin`, etc.) is Chromium/V8 runtime machinery, not your code — this is why the output is large even though the app itself is a few KB of JS/HTML.
4. **Package as portable** — `win.target: "portable"` tells electron-builder to pack the whole `win-unpacked` folder into a **single self-extracting `.exe`**: `dist/Team Capacity Calculator 1.0.0.exe`.
   - "Portable" = no installer, no registry entries, no admin rights required. Double-click → it self-extracts to a temp folder and runs.
   - `signAndEditExecutable: false` — the exe is not code-signed (fine for internal/team distribution; Windows SmartScreen may warn on first run from an unfamiliar machine).

To build it yourself: `npm install` once, then `npm run dist`. To run in dev mode without packaging: `npm start` (runs `electron .` directly against the source files).

---

## 5. File map

| File | Role |
|---|---|
| `main.js` | Electron main process: window creation, IPC handlers, `config.json` ownership |
| `preload.js` | Context bridge exposing `window.electronAPI` to the sandboxed renderer |
| `PI_SysMgm_Team_Capacity.html` | The actual app — UI, state, calculations (unchanged by the Electron wrapper) |
| `package.json` | `npm start` (dev run) / `npm run dist` (electron-builder → portable `.exe`) build config |
| `dist/` | Build output: `win-unpacked/` (raw assembled app) + the final portable `.exe` |

See `CONTEXT.md` for the data model, save/backup/conflict logic, formulas, and UI sections — this file only covers the Electron/packaging layer.
