const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');

async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}
async function writeConfig(partial) {
  const current = await readConfig();
  const next = { ...current, ...partial };
  await fs.writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile('PI_SysMgm_Team_Capacity.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('config:get', () => readConfig());
ipcMain.handle('config:set', (_e, partial) => writeConfig(partial));

ipcMain.handle('dialog:pickOpen', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('dialog:pickSave', async (_e, suggestedName) => {
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: suggestedName || 'PI_SysMgm_Capacity.json',
    filters: [{ name: 'JSON', extensions: ['json'] }]
  });
  return canceled ? null : filePath;
});

ipcMain.handle('file:read', async (_e, filePath) => {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return { ok: true, text };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: true, text: null };
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('file:write', async (_e, filePath, text) => {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, text, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ══════════════════════════════════════════════════════════════
// TFS SPRINT PULL (Planned / Executed Story Points via WIQL)
// ══════════════════════════════════════════════════════════════

// Extracts the full System.IterationPath from a pasted TFS sprint backlog
// URL, e.g. ".../_sprints/backlog/{team}/{project}/2026/PI20 - SysMgm/Sprint 20-1 (162)"
// -> "{configuredProject}\2026\PI20 - SysMgm\Sprint 20-1 (162)".
// Only the path SUFFIX is taken from the pasted URL — the request always
// targets the configured collectionUrl/project, never a host parsed from
// user-pasted text, so a wrong/malicious URL can never redirect the PAT.
function extractIterationPath(tfsUrl, project) {
  if (!tfsUrl) throw new Error('No TFS URL set for this iteration.');
  const marker = '_sprints/backlog/';
  const idx = tfsUrl.indexOf(marker);
  if (idx === -1) {
    throw new Error("That doesn't look like a TFS sprint backlog URL (expected \"_sprints/backlog/\" in the path).");
  }
  let rest = tfsUrl.slice(idx + marker.length);
  rest = rest.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segments = rest.split('/').filter(Boolean);
  // segments[0] = team, segments[1] = project (repeated in TFS's URL scheme) — skip both.
  const pathSegments = segments.slice(2).map(s => decodeURIComponent(s));
  if (!pathSegments.length) {
    throw new Error('Could not parse an iteration path out of that TFS URL.');
  }
  return [project, ...pathSegments].join('\\');
}

function tfsAuthHeader(pat) {
  return 'Basic ' + Buffer.from(':' + pat).toString('base64');
}

async function runWiql(collectionUrl, project, pat, iterationPath) {
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${iterationPath.replace(/'/g, "''")}' AND [System.WorkItemType] IN ('User Story','Bug') AND [System.State] <> 'Removed'`;
  const url = `${collectionUrl}/${project}/_apis/wit/wiql?api-version=5.0`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: tfsAuthHeader(pat), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(30000)
  });
  if (!resp.ok) throw new Error(`TFS query failed (${resp.status} ${resp.statusText}). Check the collection URL/project and PAT scope.`);
  const data = await resp.json();
  return (data.workItems || []).map(w => w.id);
}

async function getWorkItemsBatch(collectionUrl, project, pat, ids) {
  const fields = 'System.Title,System.WorkItemType,System.Tags,System.State,Microsoft.VSTS.Scheduling.StoryPoints';
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const url = `${collectionUrl}/${project}/_apis/wit/workitems?ids=${chunk.join(',')}&fields=${encodeURIComponent(fields)}&api-version=5.0`;
    const resp = await fetch(url, {
      headers: { Authorization: tfsAuthHeader(pat) },
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) throw new Error(`TFS work item fetch failed (${resp.status} ${resp.statusText}).`);
    const data = await resp.json();
    items.push(...(data.value || []));
  }
  return items;
}

// Bug -> always Dev. User Story -> DEV-tag-only -> Dev, QA-tag-only -> QA,
// both/neither -> Team (informational only, never folded into Dev/QA actuals).
// Tags are matched as exact trimmed tokens (not substring) since System.Tags
// also carries unrelated tags like "19C"/"19Planned"/"SysMgm Core 3.1.0".
// Returns both the aggregate sums AND a per-item list (every item returned by
// the WIQL query, not just the ones counted) so the UI can show exactly which
// work item landed in which bucket — including ones excluded from the
// 'executed' total because they aren't Closed yet — for tag auditing.
function classifyItems(rawItems, mode) {
  let devSP = 0, qaSP = 0, teamSP = 0, itemCount = 0;
  const items = [];
  for (const item of rawItems) {
    const f = item.fields || {};
    const type  = f['System.WorkItemType'];
    const state = f['System.State'];
    const sp    = Number(f['Microsoft.VSTS.Scheduling.StoryPoints']) || 0;
    let bucket;
    if (type === 'Bug') {
      bucket = 'dev';
    } else {
      const tags = String(f['System.Tags'] || '').split(';').map(t => t.trim().toUpperCase());
      const hasDev = tags.includes('DEV');
      const hasQa = tags.includes('QA');
      bucket = (hasDev && !hasQa) ? 'dev' : (hasQa && !hasDev) ? 'qa' : 'team';
    }
    const counted = mode !== 'executed' || state === 'Closed';
    items.push({ id: item.id, title: f['System.Title'] || '', type, state, sp, bucket, counted });
    if (counted) {
      itemCount++;
      if (bucket === 'dev') devSP += sp;
      else if (bucket === 'qa') qaSP += sp;
      else teamSP += sp;
    }
  }
  return { devSP, qaSP, teamSP, totalSP: devSP + qaSP + teamSP, itemCount, items };
}

function encryptPat(pat) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is unavailable on this machine — cannot store the PAT securely.');
  }
  return safeStorage.encryptString(pat).toString('base64');
}

function decryptPat(encoded) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is unavailable on this machine — cannot read the stored PAT.');
  }
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'));
  } catch {
    throw new Error('Could not decrypt the stored TFS PAT (it may have been saved on a different machine/account) — re-enter it in TFS Settings.');
  }
}

ipcMain.handle('tfs:getSettings', async () => {
  const cfg = await readConfig();
  return {
    collectionUrl: cfg.tfsCollectionUrl || '',
    project: cfg.tfsProject || '',
    hasPat: !!cfg.tfsPatEncrypted
  };
});

ipcMain.handle('tfs:setSettings', async (_e, partial = {}) => {
  try {
    const update = {};
    if (typeof partial.collectionUrl === 'string') update.tfsCollectionUrl = partial.collectionUrl.trim().replace(/\/+$/, '');
    if (typeof partial.project === 'string') update.tfsProject = partial.project.trim().replace(/\/+$/, '');
    if (typeof partial.pat === 'string') {
      // Empty string = explicit "Clear PAT"; non-empty = encrypt + store.
      // (Caller omits `pat` entirely to leave it unchanged on a blank field.)
      update.tfsPatEncrypted = partial.pat === '' ? undefined : encryptPat(partial.pat);
    }
    await writeConfig(update);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('tfs:fetchSprint', async (_e, { tfsUrl, mode } = {}) => {
  try {
    if (mode !== 'planned' && mode !== 'executed') return { ok: false, error: 'Invalid pull mode.' };
    const cfg = await readConfig();
    if (!cfg.tfsCollectionUrl || !cfg.tfsProject) return { ok: false, error: 'TFS connection not configured — open TFS Settings first.' };
    if (!cfg.tfsPatEncrypted) return { ok: false, error: 'TFS PAT not configured — open TFS Settings first.' };

    const pat = decryptPat(cfg.tfsPatEncrypted);
    const iterationPath = extractIterationPath(tfsUrl, cfg.tfsProject);
    const ids = await runWiql(cfg.tfsCollectionUrl, cfg.tfsProject, pat, iterationPath);
    if (!ids.length) return { ok: true, devSP: 0, qaSP: 0, teamSP: 0, totalSP: 0, itemCount: 0, items: [], pulledAt: new Date().toISOString() };

    const rawItems = await getWorkItemsBatch(cfg.tfsCollectionUrl, cfg.tfsProject, pat, ids);
    const result = classifyItems(rawItems, mode);
    return { ok: true, ...result, pulledAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('tfs:openWorkItem', async (_e, id) => {
  try {
    const cfg = await readConfig();
    if (!cfg.tfsCollectionUrl || !cfg.tfsProject) return { ok: false, error: 'TFS connection not configured.' };
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) return { ok: false, error: 'Invalid work item id.' };
    await shell.openExternal(`${cfg.tfsCollectionUrl}/${cfg.tfsProject}/_workitems/edit/${numId}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
