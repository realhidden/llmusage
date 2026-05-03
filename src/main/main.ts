import { app, BrowserWindow, ipcMain, nativeImage, shell, Tray, Menu } from 'electron';
import { menubar } from 'menubar';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './claude/store.js';
import { Watcher } from './claude/watcher.js';
import { loadConfig, saveConfig } from './config.js';
import { registerIPC, broadcast } from './ipc.js';
import type { StoreSnapshot } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let store: Store;
let watcher: Watcher;
let mb: ReturnType<typeof menubar> | null = null;

app.whenReady().then(async () => {
  app.dock?.hide();

  store = new Store();
  watcher = new Watcher(store, {
    onError: (scope, message) => {
      console.error(`[${scope}] ${message}`);
    },
  });

  await watcher.coldScan();

  // Create tray icon (16x16 template image)
  const iconPath = join(__dirname, '..', '..', '..', 'build', 'icons', 'trayTemplate.png');
  let trayIcon: Electron.NativeImage;
  try {
    trayIcon = nativeImage.createFromPath(iconPath);
    if (trayIcon.isEmpty()) trayIcon = createDefaultIcon();
  } catch {
    trayIcon = createDefaultIcon();
  }

  mb = menubar({
    browserWindow: {
      width: 360,
      height: 560,
      minWidth: 360,
      minHeight: 480,
      resizable: false,
      frame: false,
      transparent: false,
      backgroundColor: '#1e1e2e',
      alwaysOnTop: false,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    },
    icon: trayIcon,
    showDockIcon: false,
    tooltip: 'mystatus — Claude Code usage',
  });

  mb.on('ready', () => {
    mb?.tray?.setToolTip('mystatus — Claude Code usage');

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Open', click: () => mb?.showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]);
    mb?.tray?.setContextMenu(contextMenu);
  });

  mb.on('after-create-window', () => {
    const win = mb?.window;
    if (!win) return;

    if (isDev) {
      win.loadURL('http://localhost:5173');
      win.webContents.openDevTools({ mode: 'detach' });
    } else {
      win.loadFile(join(__dirname, '..', '..', 'renderer', 'index.html'));
    }

    // Send initial snapshot
    win.webContents.on('did-finish-load', () => {
      win.webContents.send('store:update', store.snapshot());
    });
  });

  // Store change -> broadcast
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  store.onChange(() => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(async () => {
      broadcastTimer = null;
      const snap = store.snapshot();
      const config = await loadConfig();
      if (config.limits) {
        snap.limits.fiveHourTokens = config.limits.fiveHourTokens;
        snap.limits.weeklyTokens = config.limits.weeklyTokens;
      }
      const win = mb?.window;
      if (win && !win.isDestroyed()) {
        win.webContents.send('store:update', snap);
      }
    }, 200);
  });

  // Auto-launch
  const config = await loadConfig();
  if (config.autoLaunch) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  // Start file watcher
  watcher.start();

  // IPC handlers
  registerIPC(ipcMain, {
    'store:snapshot': async () => {
      const snap = store.snapshot();
      const config = await loadConfig();
      if (config.limits) {
        snap.limits.fiveHourTokens = config.limits.fiveHourTokens;
        snap.limits.weeklyTokens = config.limits.weeklyTokens;
      }
      return snap;
    },
    'config:get': async () => loadConfig(),
    'config:set': async (_event, args) => saveConfig(args as Partial<import('../shared/types.js').Config>),
    'app:openProject': async (_event, args) => {
      const { cwd } = args as { cwd: string };
      shell.showItemInFolder(cwd);
    },
    'app:quit': async () => app.quit(),
  });
});

app.on('window-all-closed', () => {
  // Don't quit — menu bar apps stay alive
});

function createDefaultIcon(): Electron.NativeImage {
  const size = 16;
  const rgba = Buffer.alloc(size * size * 4, 0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - 7.5, dy = y - 7.5;
      if (dx * dx + dy * dy <= 36) {
        const i = (y * size + x) * 4;
        rgba[i] = 0;
        rgba[i + 1] = 0;
        rgba[i + 2] = 0;
        rgba[i + 3] = 200;
      }
    }
  }
  return nativeImage.createFromBuffer(rgba, { width: size, height: size });
}
