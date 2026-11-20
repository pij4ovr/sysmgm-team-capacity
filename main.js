const { app, BrowserWindow, ipcMain, dialog, safeStorage, shell, clipboard } = require('electron');
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
  // Restore the saved app zoom on every load, and route Ctrl + / Ctrl - /
  // Ctrl 0 through setAppZoom() so the keyboard and the header buttons share
  // one saved value (the default menu's own zoom accelerators would change
  // it without saving or updating the header's % label).
  win.webContents.on('did-finish-load', async () => {
    const cfg = await readConfig();
    const z = clampZoom(cfg.appZoom || 1);
    win.webContents.setZoomFactor(z);
    win.webContents.send('app:zoomChanged', z);
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    const step = { '=': 0.1, '+': 0.1, '-': -0.1, '0': 0 }[input.key];
    if (step === undefined) return;
    event.preventDefault();
    setAppZoom(win.webContents, step === 0 ? 1 : win.webContents.getZoomFactor() + step);
  });
  win.loadFile('PI_SysMgm_Team_Capacity.html');
}

// App-wide zoom (real page zoom, so popups and charts scale together), saved
// in config.json so the app reopens at the user's chosen size.
function clampZoom(z) {
  return Math.min(2, Math.max(0.7, Math.round(Number(z) * 10) / 10 || 1));
}

async function setAppZoom(webContents, z) {
  const zoom = clampZoom(z);
  webContents.setZoomFactor(zoom);
  webContents.send('app:zoomChanged', zoom);
  await writeConfig({ appZoom: zoom });
  return zoom;
}

// `delta` 0 = reset to 100%.
ipcMain.handle('app:changeZoom', (e, delta) =>
  setAppZoom(e.sender, delta === 0 ? 1 : e.sender.getZoomFactor() + Number(delta || 0)));

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('clipboard:writeText', (_e, text) => { clipboard.writeText(String(text || '')); return { ok: true }; });

// ══════════════════════════════════════════════════════════════
// REPORT EXPORT (Sprint Report → PDF / PNG)
// ══════════════════════════════════════════════════════════════

// Renders a self-contained HTML string (built in the renderer — see
// buildSprintReviewExportHtml() in PI_SysMgm_Team_Capacity.html) in a
// hidden, offscreen BrowserWindow and exports it as a PDF or PNG. A
// separate window (not the live app window) so the export is never
// clipped by the modal's own scroll/viewport, and never flashes on
// screen — `show:false` still renders normally, capturePage() works fine
// on a hidden window, same trick apps use for thumbnail generation.
ipcMain.handle('report:export', async (_e, { html, format, suggestedName } = {}) => {
  if (format !== 'pdf' && format !== 'png') return { ok: false, error: 'Invalid export format.' };
  const ext = format;
  const { canceled, filePath } = await dialog.showSaveDialog({
    defaultPath: (suggestedName || 'sprint-report') + '.' + ext,
    filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'PNG Image', extensions: ['png'] }]
  });
  if (canceled || !filePath) return { ok: false, canceled: true };

  const tmpHtmlPath = path.join(app.getPath('temp'), `sprint-report-${Date.now()}.html`);
  let win;
  try {
    await fs.writeFile(tmpHtmlPath, html, 'utf8');
    // Wide layout (~1500px), like the in-app report on a big screen: at the
    // old 900px the Dev/QA/Team columns were so narrow that every title
    // wrapped a word per line. The PDF gets the same width by printing A4
    // landscape at 70% scale (A4 landscape minus margins is ~1070 CSS px).
    const EXPORT_WIDTH = 1500;
    win = new BrowserWindow({ show: false, width: EXPORT_WIDTH, height: 900 });
    await win.loadFile(tmpHtmlPath);

    if (format === 'pdf') {
      const buffer = await win.webContents.printToPDF({
        printBackground: true, pageSize: 'A4', landscape: true, scale: 0.7,
        margins: { top: 0.3, bottom: 0.3, left: 0.3, right: 0.3 }
      });
      await fs.writeFile(filePath, buffer);
    } else {
      // Resize to the full rendered content height first, so the capture
      // isn't cropped to the window's initial (arbitrary) viewport size.
      const contentHeight = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
      win.setContentSize(EXPORT_WIDTH, Math.max(600, Math.ceil(contentHeight) + 20));
      await new Promise(resolve => setTimeout(resolve, 100)); // let the resize repaint
      const image = await win.webContents.capturePage();
      await fs.writeFile(filePath, image.toPNG());
    }
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (win && !win.isDestroyed()) win.destroy();
    fs.unlink(tmpHtmlPath).catch(() => {});
  }
});

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

// Extracts the wiki identifier and the page's display *slug* from a pasted
// TFS wiki page URL, e.g. ".../_wiki/wikis/System%20Manager/9699/PI-20" —
// segment right after "_wiki/wikis/" is the wiki's name, the LAST segment
// (here "PI-20") is the page's URL-safe slug for display. The middle
// numeric segment is ignored entirely: on Azure DevOps Services it's the
// page's id, but this on-prem server's Wiki REST API (at api-version=5.0)
// doesn't expose `id` on pages at all (confirmed: a page-tree fetch's nodes
// come back with no `id` property whatsoever) and has no working "get page
// by id" route either — so id-based lookup is a dead end here regardless of
// what's in the URL. The slug is NOT the page's real path either (TFS's
// slug substitutes hyphens for spaces, among other things — a page titled
// "PI 20" has `path: "/PI 20"`, and creating a child under the literal
// "/PI-20" 404s with "ancestor page does not exist" since no page is
// actually named that) — findWikiPagePathBySlug() below resolves the real
// path by matching this slug (loosely, see slugify()) against the actual
// page tree instead. Like extractIterationPath(), only URL SUFFIXES are
// ever taken from the pasted URL — the actual HTTP request always targets
// the configured collectionUrl/project, never a host parsed from the URL.
function extractWikiPathInfo(wikiUrl) {
  if (!wikiUrl) throw new Error('No wiki page URL set for this PI.');
  const marker = '_wiki/wikis/';
  const idx = wikiUrl.indexOf(marker);
  if (idx === -1) {
    throw new Error('That doesn\'t look like a TFS wiki page URL (expected "_wiki/wikis/" in the path).');
  }
  let rest = wikiUrl.slice(idx + marker.length);
  rest = rest.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const segments = rest.split('/').filter(Boolean).map(s => decodeURIComponent(s));
  if (segments.length < 2) {
    throw new Error('Could not parse a wiki name and page name out of that URL (expected .../_wiki/wikis/{name}/{pageId}/{page-slug}).');
  }
  const wikiName = segments[0];
  const pageSlug = segments[segments.length - 1];
  return { wikiName, pageSlug };
}

// TFS's own slug substitution isn't publicly documented in detail, so this
// only approximates the one rule we've actually observed (spaces -> hyphens)
// — good enough to match a page's real path's last segment against the
// slug from a pasted URL without needing an exact, guaranteed-correct
// reverse transform.
function slugify(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function lastPathSegment(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Finds a wiki page's real `path` by matching `pageSlug` (from a pasted URL,
// see extractWikiPathInfo() above) against the last segment of each page's
// actual `path`, walking the whole page tree (`GET .../pages?path=/&
// recursionLevel=Full` — the same "get page" route we already know this
// server supports, recursing from the root; each node's `subPages` holds
// its children).
async function findWikiPagePathBySlug(collectionUrl, project, pat, wikiName, pageSlug, branch) {
  const base = `${collectionUrl}/${project}/_apis/wiki/wikis/${encodeURIComponent(wikiName)}/pages`;
  let qs = `path=${encodeURIComponent('/')}&recursionLevel=Full&api-version=5.0`;
  if (branch) qs += `&versionDescriptor.versionType=branch&versionDescriptor.version=${encodeURIComponent(branch)}`;
  const resp = await fetch(`${base}?${qs}`, { headers: { Authorization: tfsAuthHeader(pat) }, signal: AbortSignal.timeout(20000) });
  if (!resp.ok) {
    throw new Error(`Could not look up the wiki page tree (${resp.status} ${resp.statusText}${await tfsErrorDetail(resp)}).`);
  }
  const root = await resp.json();
  const target = slugify(pageSlug);
  function search(node) {
    if (!node) return null;
    if (slugify(lastPathSegment(node.path)) === target) return node.path;
    for (const sub of (node.subPages || [])) {
      const found = search(sub);
      if (found) return found;
    }
    return null;
  }
  const path = search(root);
  if (!path) {
    throw new Error(`Could not find a wiki page named "${pageSlug}" in that wiki's page tree — check the pasted wiki page URL.`);
  }
  return path;
}

// Creates or updates a wiki page at `pagePath` with `content` (Markdown).
// GETs first to pick up the current page's ETag (required as `If-Match` on
// an update — a create needs no such header); a 404 on the GET just means
// this is a brand-new page, not an error.
// TFS/Azure DevOps error responses are usually JSON with a human-readable
// `message` (and often a TF#### error code) — surfacing that instead of just
// the HTTP status is the difference between "400 Bad Request" (meaningless)
// and knowing exactly what TFS rejected and why.
async function tfsErrorDetail(resp) {
  try {
    const body = await resp.json();
    if (body && body.message) return ` — ${body.message}`;
  } catch {}
  return '';
}

// `branch` is the name of the git branch backing this project's wiki (every
// project wiki is git-backed under the hood). Azure DevOps Services usually
// infers this on its own, but at least one on-prem TFS setup we've seen
// can't — it 400s with "The versionType should be 'branch' and version
// cannot not be null" unless `versionDescriptor.versionType`/`.version` are
// passed explicitly. Omitted (falsy) when not configured, preserving the
// original (inferred) behavior for instances where that already works.
async function publishWikiPage(collectionUrl, project, pat, wikiName, pagePath, content, branch) {
  const base = `${collectionUrl}/${project}/_apis/wiki/wikis/${encodeURIComponent(wikiName)}/pages`;
  let qs = `path=${encodeURIComponent(pagePath)}&api-version=5.0`;
  if (branch) qs += `&versionDescriptor.versionType=branch&versionDescriptor.version=${encodeURIComponent(branch)}`;
  const getResp = await fetch(`${base}?${qs}`, {
    headers: { Authorization: tfsAuthHeader(pat) },
    signal: AbortSignal.timeout(20000)
  });
  let eTag = null;
  if (getResp.ok) {
    eTag = getResp.headers.get('eTag');
  } else if (getResp.status !== 404) {
    throw new Error(`Could not check the existing wiki page (${getResp.status} ${getResp.statusText}${await tfsErrorDetail(getResp)}).`);
  }
  const headers = { Authorization: tfsAuthHeader(pat), 'Content-Type': 'application/json' };
  if (eTag) headers['If-Match'] = eTag;
  const putResp = await fetch(`${base}?${qs}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(20000)
  });
  if (!putResp.ok) {
    throw new Error(`Wiki page publish failed (${putResp.status} ${putResp.statusText}${await tfsErrorDetail(putResp)}).`);
  }
  const data = await putResp.json();
  return { path: data.path, id: data.id };
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

// `fields` and `$expand` are mutually exclusive on this endpoint, and we now
// need the parent-Feature relation, so this fetches the full field set
// (fields we don't use are simply ignored) plus relations.
async function getWorkItemsBatch(collectionUrl, project, pat, ids) {
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const url = `${collectionUrl}/${project}/_apis/wit/workitems?ids=${chunk.join(',')}&$expand=relations&api-version=5.0`;
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

// Parent is a work-item-link relation (System.LinkTypes.Hierarchy-Reverse),
// not a plain field — its id is the trailing number on the relation's url.
function extractParentId(rawItem) {
  const rel = (rawItem.relations || []).find(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
  if (!rel || !rel.url) return null;
  const m = rel.url.match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

// Lightweight batch fetch for parent Features — just enough to label a group
// header (Title/WorkItemType), no relations needed for these.
async function getParentsInfo(collectionUrl, project, pat, ids) {
  const map = {};
  if (!ids.length) return map;
  const fields = 'System.Title,System.WorkItemType,System.State';
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const url = `${collectionUrl}/${project}/_apis/wit/workitems?ids=${chunk.join(',')}&fields=${encodeURIComponent(fields)}&api-version=5.0`;
    const resp = await fetch(url, {
      headers: { Authorization: tfsAuthHeader(pat) },
      signal: AbortSignal.timeout(30000)
    });
    if (!resp.ok) throw new Error(`TFS parent fetch failed (${resp.status} ${resp.statusText}).`);
    const data = await resp.json();
    (data.value || []).forEach(w => {
      map[w.id] = { title: w.fields['System.Title'] || '', type: w.fields['System.WorkItemType'] || '', state: w.fields['System.State'] || '' };
    });
  }
  return map;
}

// ── PI roadmap pull (Features on a Delivery Plan, or in a saved query) ──
// Same security model as extractIterationPath(): only the GUID is taken from
// the pasted URL — every request goes to the configured collection/project.
function extractRoadmapSource(url) {
  if (!url) throw new Error('No roadmap URL set for this PI.');
  const guid = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
  const plan = url.match(new RegExp('_deliveryplans/plan/' + guid));
  if (plan) return { kind: 'plan', id: plan[1] };
  const query = url.match(new RegExp('_queries/query(?:-edit)?/' + guid));
  if (query) return { kind: 'query', id: query[1] };
  throw new Error('Expected a Delivery Plan URL (.../_deliveryplans/plan/{id}) or a saved query URL (.../_queries/query/{id}).');
}

// The timeline's work items are arrays of field values, ordered like the
// matching *FieldReferenceNames list — only the id is taken from them; every
// other field comes from getWorkItemsBatch() so we don't depend on which
// fields a given plan happens to be configured to show.
function collectTimelineIds(timeline) {
  const ids = new Set();
  const take = (rows, names) => {
    const idx = Math.max(0, (names || []).indexOf('System.Id'));
    (rows || []).forEach(r => { const v = Array.isArray(r) ? r[idx] : (r && r.id); if (Number.isInteger(Number(v))) ids.add(Number(v)); });
  };
  (timeline.teams || []).forEach(t => {
    take(t.workItems, t.fieldReferenceNames);
    take(t.partiallyPagedWorkItems, t.partiallyPagedFieldReferenceNames);
    (t.iterations || []).forEach(it => {
      take(it.workItems, t.fieldReferenceNames);
      take(it.partiallyPagedWorkItems, t.partiallyPagedFieldReferenceNames);
    });
  });
  return [...ids];
}

// The server rejects any timeline window of 65+ days (VS403164), and a PI is
// ~12 weeks — so the PI range is fetched in ≤60-day windows and the ids
// unioned (a feature spanning two windows just appears in both).
async function fetchDeliveryPlanIds(collectionUrl, project, pat, planId, startDate, endDate) {
  const DAY = 86400000, WINDOW_DAYS = 60;
  const iso = d => d.toISOString().slice(0, 10);
  const end = new Date(endDate + 'T00:00:00Z');
  const ids = new Set();
  for (let from = new Date(startDate + 'T00:00:00Z'); from <= end; from = new Date(from.getTime() + WINDOW_DAYS * DAY)) {
    const to = new Date(Math.min(from.getTime() + (WINDOW_DAYS - 1) * DAY, end.getTime()));
    const url = `${collectionUrl}/${project}/_apis/work/plans/${planId}/deliverytimeline?startDate=${iso(from)}&endDate=${iso(to)}&api-version=5.0-preview.1`;
    const resp = await fetch(url, { headers: { Authorization: tfsAuthHeader(pat) }, signal: AbortSignal.timeout(30000) });
    if (!resp.ok) {
      throw new Error(`Delivery Plan fetch failed (${resp.status} ${resp.statusText}${await tfsErrorDetail(resp)}). If your TFS version doesn't support this, paste a saved query URL instead.`);
    }
    collectTimelineIds(await resp.json()).forEach(id => ids.add(id));
  }
  return [...ids];
}

// Runs a saved query by id. Flat queries return `workItems`; tree / one-hop
// queries return `workItemRelations` — both sides of every relation are kept,
// the Feature-type filter afterwards drops whatever isn't a Feature.
async function fetchSavedQueryIds(collectionUrl, project, pat, queryId) {
  const url = `${collectionUrl}/${project}/_apis/wit/wiql/${queryId}?api-version=5.0`;
  const resp = await fetch(url, { headers: { Authorization: tfsAuthHeader(pat) }, signal: AbortSignal.timeout(30000) });
  if (!resp.ok) throw new Error(`Saved query failed (${resp.status} ${resp.statusText}${await tfsErrorDetail(resp)}).`);
  const data = await resp.json();
  const ids = new Set((data.workItems || []).map(w => w.id));
  (data.workItemRelations || []).forEach(r => { if (r.source) ids.add(r.source.id); if (r.target) ids.add(r.target.id); });
  return [...ids];
}

// Bug -> always Dev. User Story -> DEV-tag-only -> Dev, QA-tag-only -> QA,
// both/neither -> Team (informational only, never folded into Dev/QA actuals).
// Tags are matched as exact trimmed tokens (not substring) since System.Tags
// also carries unrelated tags like "19C"/"19Planned"/"SysMgm Core 3.1.0".
// Returns both the aggregate sums AND a per-item list (every item returned by
// the WIQL query, not just the ones counted) so the UI can show exactly which
// work item landed in which bucket — including ones excluded from the
// 'executed' total because they aren't Closed yet — for tag auditing.
function classifyItems(rawItems, mode, parentMap) {
  parentMap = parentMap || {};
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
    const parentId = extractParentId(item);
    const parent = parentId != null ? parentMap[parentId] : null;
    items.push({
      id: item.id, title: f['System.Title'] || '', type, state, sp, bucket, counted,
      parentId: parentId, parentTitle: parent ? parent.title : null, parentState: parent ? parent.state : null,
      parentEpicId: parent ? parent.epicId : null, parentEpicTitle: parent ? parent.epicTitle : null, parentEpicState: parent ? parent.epicState : null
    });
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
    wikiBranch: cfg.tfsWikiBranch || '',
    hasPat: !!cfg.tfsPatEncrypted
  };
});

ipcMain.handle('tfs:setSettings', async (_e, partial = {}) => {
  try {
    const update = {};
    if (typeof partial.collectionUrl === 'string') update.tfsCollectionUrl = partial.collectionUrl.trim().replace(/\/+$/, '');
    if (typeof partial.project === 'string') update.tfsProject = partial.project.trim().replace(/\/+$/, '');
    if (typeof partial.wikiBranch === 'string') update.tfsWikiBranch = partial.wikiBranch.trim();
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
    // Two levels up: each item's parent Feature, and that Feature's parent
    // Epic (the sprint report groups Feature rows by Epic). The Features are
    // fetched with relations (getWorkItemsBatch) so their own parent is known.
    const parentIds = [...new Set(rawItems.map(extractParentId).filter(id => id != null))];
    const parentRaw = parentIds.length ? await getWorkItemsBatch(cfg.tfsCollectionUrl, cfg.tfsProject, pat, parentIds) : [];
    const epicIds = [...new Set(parentRaw.map(extractParentId).filter(id => id != null))];
    const epicMap = await getParentsInfo(cfg.tfsCollectionUrl, cfg.tfsProject, pat, epicIds);
    const parentMap = {};
    parentRaw.forEach(w => {
      const f = w.fields || {};
      const epicId = extractParentId(w);
      const epic = epicId != null ? epicMap[epicId] : null;
      parentMap[w.id] = {
        title: f['System.Title'] || '', type: f['System.WorkItemType'] || '', state: f['System.State'] || '',
        epicId: epic ? epicId : null, epicTitle: epic ? epic.title : null, epicState: epic ? epic.state : null
      };
    });
    const result = classifyItems(rawItems, mode, parentMap);
    return { ok: true, ...result, pulledAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('tfs:fetchRoadmap', async (_e, { url, startDate, endDate } = {}) => {
  try {
    const cfg = await readConfig();
    if (!cfg.tfsCollectionUrl || !cfg.tfsProject) return { ok: false, error: 'TFS connection not configured — open TFS Settings first.' };
    if (!cfg.tfsPatEncrypted) return { ok: false, error: 'TFS PAT not configured — open TFS Settings first.' };
    const pat = decryptPat(cfg.tfsPatEncrypted);
    const src = extractRoadmapSource(url);
    let ids;
    if (src.kind === 'plan') {
      if (!startDate || !endDate) return { ok: false, error: 'This PI has no iteration dates — the Delivery Plan pull needs the PI start/end.' };
      ids = await fetchDeliveryPlanIds(cfg.tfsCollectionUrl, cfg.tfsProject, pat, src.id, startDate, endDate);
    } else {
      ids = await fetchSavedQueryIds(cfg.tfsCollectionUrl, cfg.tfsProject, pat, src.id);
    }
    const raw = (ids.length ? await getWorkItemsBatch(cfg.tfsCollectionUrl, cfg.tfsProject, pat, ids) : [])
      .filter(w => (w.fields || {})['System.WorkItemType'] === 'Feature');
    // Each Feature's parent (normally its Epic) — the PI summary groups by it.
    const parentIds = [...new Set(raw.map(extractParentId).filter(id => id != null))];
    const parents = await getParentsInfo(cfg.tfsCollectionUrl, cfg.tfsProject, pat, parentIds);
    const features = raw
      .map(w => {
        const parentId = extractParentId(w);
        const parent = parentId != null ? parents[parentId] : null;
        return {
          id: w.id,
          title: w.fields['System.Title'] || '',
          state: w.fields['System.State'] || '',
          iterationPath: w.fields['System.IterationPath'] || '',
          epicId: parent ? parentId : null,
          epicTitle: parent ? parent.title : null
        };
      })
      .sort((a, b) => a.id - b.id);
    return { ok: true, source: src.kind, features, pulledAt: new Date().toISOString() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Lightweight connectivity check for TFS Settings' "Test Connection" button —
// hits the project metadata endpoint (no iteration path needed) so a bad
// PAT/URL/project is caught immediately instead of on the first real pull.
// Accepts whatever is currently typed in the modal (even unsaved), falling
// back to the already-saved setting for any field left blank, so re-testing
// after a PAT is already stored doesn't require retyping it.
async function testTfsConnection(collectionUrl, project, pat) {
  const url = `${collectionUrl}/_apis/projects/${encodeURIComponent(project)}?api-version=5.0`;
  const resp = await fetch(url, { headers: { Authorization: tfsAuthHeader(pat) }, signal: AbortSignal.timeout(15000) });
  if (resp.status === 401 || resp.status === 403) {
    throw new Error('Authentication failed — check the PAT and that it has "Work Items: Read" scope.');
  }
  if (resp.status === 404) {
    throw new Error(`Project "${project}" not found at that Collection URL — check the project name.`);
  }
  if (!resp.ok) {
    throw new Error(`Could not reach TFS (${resp.status} ${resp.statusText}). Check the Collection URL.`);
  }
  const data = await resp.json();
  return { name: data.name || project };
}

ipcMain.handle('tfs:testConnection', async (_e, partial = {}) => {
  try {
    const cfg = await readConfig();
    const collectionUrl = (typeof partial.collectionUrl === 'string' && partial.collectionUrl)
      ? partial.collectionUrl.trim().replace(/\/+$/, '') : cfg.tfsCollectionUrl;
    const project = (typeof partial.project === 'string' && partial.project)
      ? partial.project.trim().replace(/\/+$/, '') : cfg.tfsProject;
    const pat = (typeof partial.pat === 'string' && partial.pat)
      ? partial.pat : (cfg.tfsPatEncrypted ? decryptPat(cfg.tfsPatEncrypted) : null);
    if (!collectionUrl || !project) return { ok: false, error: 'Enter a Collection URL and Project first.' };
    if (!pat) return { ok: false, error: 'Enter a PAT first (or save one, then test again).' };
    const info = await testTfsConnection(collectionUrl, project, pat);
    return { ok: true, project: info.name };
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

// Lets the user pick a Delivery Plan screenshot and uploads it as a wiki
// attachment (stored in the wiki's own repo, so it's still there when a
// later publish re-embeds it — only the returned `/.attachments/...` path is
// kept in the app's state, not the image itself).
// TFS caps a wiki attachment at ~19 MB, checked up front for a clear error.
ipcMain.handle('tfs:attachWikiImage', async (_e, { wikiUrl, baseName } = {}) => {
  try {
    const cfg = await readConfig();
    if (!cfg.tfsCollectionUrl || !cfg.tfsProject) return { ok: false, error: 'TFS connection not configured — open TFS Settings first.' };
    if (!cfg.tfsPatEncrypted) return { ok: false, error: 'TFS PAT not configured — open TFS Settings first.' };
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif'] }]
    });
    if (canceled || !filePaths.length) return { ok: false, canceled: true };
    const ext = path.extname(filePaths[0]).toLowerCase() || '.png';
    const data = await fs.readFile(filePaths[0]);
    if (data.length > 19 * 1024 * 1024) return { ok: false, error: `File is ${(data.length / 1048576).toFixed(1)} MB — TFS wiki attachments are limited to about 19 MB.` };

    const pat = decryptPat(cfg.tfsPatEncrypted);
    const { wikiName } = extractWikiPathInfo(wikiUrl);
    const name = `${String(baseName || 'image').replace(/[^\w-]+/g, '-')}-${Date.now()}${ext}`;
    let qs = `name=${encodeURIComponent(name)}&api-version=5.0`;
    if (cfg.tfsWikiBranch) qs += `&versionDescriptor.versionType=branch&versionDescriptor.version=${encodeURIComponent(cfg.tfsWikiBranch)}`;
    const resp = await fetch(`${cfg.tfsCollectionUrl}/${cfg.tfsProject}/_apis/wiki/wikis/${encodeURIComponent(wikiName)}/attachments?${qs}`, {
      method: 'PUT',
      headers: { Authorization: tfsAuthHeader(pat), 'Content-Type': 'application/octet-stream' },
      body: data.toString('base64'),
      signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) throw new Error(`Wiki attachment upload failed (${resp.status} ${resp.statusText}${await tfsErrorDetail(resp)}).`);
    const result = await resp.json();
    const attPath = (result.attachment && result.attachment.path) || result.path || `/.attachments/${name}`;
    return { ok: true, path: attPath, fileName: path.basename(filePaths[0]) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// `wikiUrl` is the PI's own pasted wiki page URL (e.g. the "PI-20" page) —
// `subPath` is appended under it (e.g. "Sprint 20.2") to address/create that
// sprint's own child page. `content` is the full Markdown body (built
// client-side, in the renderer, so it stays in sync with the Sprint Report's
// own content-building logic).
ipcMain.handle('tfs:publishWikiPage', async (_e, { wikiUrl, subPath, content } = {}) => {
  try {
    const cfg = await readConfig();
    if (!cfg.tfsCollectionUrl || !cfg.tfsProject) return { ok: false, error: 'TFS connection not configured — open TFS Settings first.' };
    if (!cfg.tfsPatEncrypted) return { ok: false, error: 'TFS PAT not configured — open TFS Settings first.' };
    const pat = decryptPat(cfg.tfsPatEncrypted);
    const { wikiName, pageSlug } = extractWikiPathInfo(wikiUrl);
    const basePagePath = await findWikiPagePathBySlug(cfg.tfsCollectionUrl, cfg.tfsProject, pat, wikiName, pageSlug, cfg.tfsWikiBranch);
    // No subPath = the PI's own wiki page (PI summary); otherwise a child page (sprint report).
    const pagePath = subPath ? `${basePagePath}/${subPath}` : basePagePath;
    const result = await publishWikiPage(cfg.tfsCollectionUrl, cfg.tfsProject, pat, wikiName, pagePath, content || '', cfg.tfsWikiBranch);
    return { ok: true, ...result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
