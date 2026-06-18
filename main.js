const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
