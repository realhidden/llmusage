import { app, BrowserWindow, ipcMain, nativeImage, shell, Tray, Menu } from 'electron';
import { menubar } from 'menubar';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store } from './claude/store.js';
import { Watcher } from './claude/watcher.js';
import { dirsFromConfig } from './claude/dirs.js';
import { loadConfig, saveConfig } from './config.js';
import { registerIPC, broadcast } from './ipc.js';
import type { StoreSnapshot, Config, DirLimits } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let store: Store;
let watcher: Watcher;
let mb: ReturnType<typeof menubar> | null = null;
let lastIconState = '';

type IconState = 'idle' | 'running' | 'waiting';

function makeIcon(state: IconState): Electron.NativeImage {
  const size = 22;
  const rgba = Buffer.alloc(size * size * 4, 0);
  const cx = size / 2, cy = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / (size / 2);
      const dy = (y - cy) / (size / 2);
      const r = Math.sqrt(dx * dx * 1.1 + dy * dy * 1.3);

      if (r >= 0.88) continue;
      const edge = Math.min(1, (0.88 - r) * size / 2.5);

      let alpha = Math.floor(edge * 220);
      let red = 0, green = 0, blue = 0;

      if (state === 'running') {
        // Green brain
        red = 0x34; green = 0xc7; blue = 0x59;
        alpha = Math.floor(edge * 230);
      } else if (state === 'waiting') {
        // Amber brain
        red = 0xff; green = 0x9f; blue = 0x0a;
        alpha = Math.floor(edge * 220);
      }
      // idle: plain black (template-compatible)

      const i = (y * size + x) * 4;
      rgba[i] = red;
      rgba[i + 1] = green;
      rgba[i + 2] = blue;
      rgba[i + 3] = alpha;
    }
  }

  return nativeImage.createFromBuffer(rgba, { width: size, height: size });
}

function updateTrayIcon(snap: StoreSnapshot): void {
  const tray = mb?.tray;
  if (!tray) return;

  const hasRunning = snap.sessions.active.some(s => s.state === 'running');
  const hasWaiting = snap.sessions.active.some(s => s.state === 'waiting-for-input');
  let state: IconState = 'idle';
  if (hasRunning) state = 'running';
  else if (hasWaiting) state = 'waiting';

  if (state === lastIconState) return;
  lastIconState = state;
  tray.setImage(makeIcon(state));

  const labels: Record<IconState, string> = {
    running: 'mystatus — working',
    waiting: 'mystatus — waiting for input',
    idle: 'mystatus — idle',
  };
  tray.setToolTip(labels[state]);
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function decorateSnapshot(snap: StoreSnapshot, config: Config): Promise<StoreSnapshot> {
  if (config.limits) {
    snap.limits.fiveHourTokens = config.limits.fiveHourTokens;
    snap.limits.weeklyTokens = config.limits.weeklyTokens;
  }
  const dirs = dirsFromConfig(config);
  const byDir: DirLimits[] = dirs.map(d => ({
    path: d.path,
    label: d.label,
    fiveHourTokens: d.fiveHourTokens,
    weeklyTokens: d.weeklyTokens,
    fiveHourUsed: store.rollingByDir(d.path, FIVE_HOURS_MS),
    weeklyUsed: store.rollingByDir(d.path, WEEK_MS),
  }));
  snap.limits.byDir = byDir;
  return snap;
}

app.whenReady().then(async () => {
  app.dock?.hide();

  store = new Store();

  const initConfig = await loadConfig();
  const normalizedDirs = dirsFromConfig(initConfig);
  const dirs = normalizedDirs.map(d => d.path);

  watcher = new Watcher(store, {
    dirs,
    onError: (scope, message) => {
      console.error(`[${scope}] ${message}`);
    },
  });

  await watcher.coldScan();

  const rendererUrl = isDev
    ? 'http://localhost:5173'
    : `file://${join(__dirname, '..', '..', 'renderer', 'index.html')}`;

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
    icon: makeIcon('idle'),
    showDockIcon: false,
    tooltip: 'mystatus — idle',
    index: rendererUrl,
  });

  mb.on('ready', () => {
    mb?.tray?.on('right-click', () => {
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Quit mystatus', click: () => app.quit() },
      ]);
      mb?.tray?.popUpContextMenu(contextMenu);
    });
  });

  mb.on('after-create-window', () => {
    const win = mb?.window;
    if (!win) return;

    if (isDev) {
      win.webContents.openDevTools({ mode: 'detach' });
    }

    win.webContents.on('did-finish-load', async () => {
      const config = await loadConfig();
      const snap = await decorateSnapshot(store.snapshot(), config);
      win.webContents.send('store:update', snap);
      updateTrayIcon(snap);
    });
  });

  // Store change -> broadcast + update icon
  let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
  store.onChange(() => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(async () => {
      broadcastTimer = null;
      const config = await loadConfig();
      const snap = await decorateSnapshot(store.snapshot(), config);
      const win = mb?.window;
      if (win && !win.isDestroyed()) {
        win.webContents.send('store:update', snap);
      }
      updateTrayIcon(snap);
    }, 200);
  });

  if (initConfig.autoLaunch) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  watcher.start();

  registerIPC(ipcMain, {
    'store:snapshot': async () => {
      const config = await loadConfig();
      return decorateSnapshot(store.snapshot(), config);
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
