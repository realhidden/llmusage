import { app, ipcMain, shell, Menu } from 'electron';
import { menubar } from 'menubar';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './claude/store.js';
import { Watcher } from './claude/watcher.js';
import { dirsFromConfig } from './claude/dirs.js';
import { loadConfig, saveConfig } from './config.js';
import { registerIPC } from './ipc.js';
import { getIcon, initIcons, type IconState } from './tray-icon.js';
import { getQuotaForDir } from './quota.js';
import { checkForUpdate, isGitHubReleaseUrl } from './update.js';
import type { StoreSnapshot, Config, DirLimits, DirPlan } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let store: Store;
let watcher: Watcher;
let mb: ReturnType<typeof menubar> | null = null;
let lastIconState: IconState = 'idle';
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkOn = false;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

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
  // per-provider routing and 60s caching. Codex gets rate limits from
  // session events via the store instead of an API call.
  const isCodexDir = (p: string) => p.includes('.codex/sessions') || p.includes('.codex\\sessions');
  const plans: DirPlan[] = await Promise.all(
    dirs.map(async d => ({
      dir: d.path,
      label: d.label,
      plan: isCodexDir(d.path) ? store.getCodexQuota(d.path) : await getQuotaForDir(d.path),
    }))
  );
  snap.limits.plans = plans.filter(p => p.plan != null);
  return snap;
}

function createWatcher(config: Config): Watcher {
  const normalizedDirs = dirsFromConfig(config);
  return new Watcher(store, {
    dirs: normalizedDirs.map(d => d.path),
    onError: (scope, message) => {
      console.error(`[${scope}] ${message}`);
    },
  });
}

async function currentSnapshot(): Promise<StoreSnapshot> {
  const config = await loadConfig();
  return decorateSnapshot(store.snapshot(), config);
}

async function sendSnapshot(): Promise<void> {
  const snap = await currentSnapshot();
  const win = mb?.window;
  if (win && !win.isDestroyed()) {
    win.webContents.send('store:update', snap);
  }
  updateTrayIcon(snap);
}

async function reloadData(config: Config): Promise<void> {
  watcher?.stop();
  store.reset();
  watcher = createWatcher(config);
  await watcher.coldScan();
  watcher.start();
  await sendSnapshot();
}

app.whenReady().then(async () => {
  app.dock?.hide();

  // Rasterize tray-icon SVGs once Chromium is ready, before we hand
  // an icon to menubar()
  await initIcons();

  store = new Store();

  const initConfig = await loadConfig();
  watcher = createWatcher(initConfig);

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
      const snap = await currentSnapshot();
      win.webContents.send('store:update', snap);
      updateTrayIcon(snap);
    });
  });

  // Store change -> broadcast + update icon
  store.onChange(() => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(async () => {
      broadcastTimer = null;
      await sendSnapshot();
    }, 200);
  });

  if (initConfig.autoLaunch) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  watcher.start();

  registerIPC(ipcMain, {
    'store:snapshot': async () => currentSnapshot(),
    'config:get': async () => loadConfig(),
    'config:set': async (_event, args) => {
      const partial = args as Partial<Config>;
      const config = await saveConfig(partial);
      if (Object.prototype.hasOwnProperty.call(partial, 'dataDirs')) {
        await reloadData(config);
      } else {
        await sendSnapshot();
      }
      app.setLoginItemSettings({ openAtLogin: config.autoLaunch === true });
      return config;
    },
    'app:openProject': async (_event, args) => {
      const { cwd } = args as { cwd: string };
      shell.showItemInFolder(cwd);
    },
    'app:checkUpdate': async () => checkForUpdate(app.getVersion()),
    'app:openUpdate': async (_event, args) => {
      const { url } = args as { url: string };
      if (isGitHubReleaseUrl(url)) {
        await shell.openExternal(url);
      }
    },
    'app:quit': async () => app.quit(),
    'app:version': async () => app.getVersion(),
  });
});

app.on('window-all-closed', () => {
  // Don't quit — menu bar apps stay alive
});
