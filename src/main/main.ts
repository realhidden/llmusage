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
import { getIcon, initIcons, type IconState } from './tray-icon.js';
import { getQuotaForDir } from './quota.js';
import type { StoreSnapshot, Config, DirLimits, DirPlan } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let store: Store;
let watcher: Watcher;
let mb: ReturnType<typeof menubar> | null = null;
let lastIconState: IconState = 'idle';
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkOn = false;

const TOOLTIPS: Record<IconState, string> = {
  running: 'llmusage — working',
  waiting: 'llmusage — waiting for input',
  idle: 'llmusage — idle',
};

function paintTray(state: IconState): void {
  const tray = mb?.tray;
  if (!tray) return;
  // Waiting blinks between full-bright and dim
  const dim = state === 'waiting' && blinkOn ? 0.4 : 1;
  tray.setImage(getIcon(state, dim));
}

function updateTrayIcon(snap: StoreSnapshot): void {
  const tray = mb?.tray;
  if (!tray) return;

  const hasRunning = snap.sessions.active.some(s => s.state === 'running');
  const hasWaiting = snap.sessions.active.some(s => s.state === 'waiting-for-input');
  let state: IconState = 'idle';
  if (hasWaiting) state = 'waiting';
  else if (hasRunning) state = 'running';

  if (state !== lastIconState) {
    lastIconState = state;
    tray.setToolTip(TOOLTIPS[state]);
  }

  // Blink only while waiting; cancel otherwise
  if (state === 'waiting') {
    if (!blinkTimer) {
      blinkOn = false;
      blinkTimer = setInterval(() => {
        blinkOn = !blinkOn;
        paintTray('waiting');
      }, 600);
    }
  } else if (blinkTimer) {
    clearInterval(blinkTimer);
    blinkTimer = null;
    blinkOn = false;
  }

  paintTray(state);
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

  // Fan out per-dir quota fetches in parallel; quota module handles
  // per-provider routing and 60s caching.
  const plans: DirPlan[] = await Promise.all(
    dirs.map(async d => ({
      dir: d.path,
      label: d.label,
      plan: await getQuotaForDir(d.path),
    }))
  );
  snap.limits.plans = plans.filter(p => p.plan != null);
  return snap;
}

app.whenReady().then(async () => {
  app.dock?.hide();

  // Rasterize tray-icon SVGs once Chromium is ready, before we hand
  // an icon to menubar()
  await initIcons();

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
    icon: getIcon('idle'),
    showDockIcon: false,
    tooltip: 'llmusage — idle',
    index: rendererUrl,
  });

  mb.on('ready', () => {
    mb?.tray?.on('right-click', () => {
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Quit llmusage', click: () => app.quit() },
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
