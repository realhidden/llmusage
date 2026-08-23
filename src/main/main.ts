import { app, ipcMain, shell, Menu, Notification } from 'electron';
import { menubar } from 'menubar';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Store } from './claude/store.js';
import { Watcher } from './claude/watcher.js';
import { dirsFromConfig } from './claude/dirs.js';
import { loadConfig, saveConfig } from './config.js';
import { registerIPC } from './ipc.js';
import { getIcon, initIcons, type IconState } from './tray-icon.js';
import { getQuotaForDir } from './quota.js';
import { checkForUpdate, isGitHubReleaseUrl } from './update.js';
import { costOfModels } from '../shared/pricing.js';
import { todayKey } from '../shared/time.js';
import type { StoreSnapshot, Config, DirLimits, DirPlan, PlanQuota, DataDirEntry } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let store: Store;
let watcher: Watcher;
let mb: ReturnType<typeof menubar> | null = null;
let lastIconState: IconState = 'idle';
let blinkTimer: ReturnType<typeof setInterval> | null = null;
let blinkOn = false;
let broadcastTimer: ReturnType<typeof setTimeout> | null = null;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
let pendingState: IconState | null = null;
let pendingWaiting: Array<{ cwd: string; models: string[] }> = [];

const TOOLTIPS: Record<IconState, string> = {
  running: 'llmusage — working',
  waiting: 'llmusage — waiting for input',
  idle: 'llmusage — idle',
};

function playCompletionSound(): void {
  execFile('afplay', ['/System/Library/Sounds/Glass.aiff'], (err) => {
    if (err) console.error('[llmusage] completion sound failed:', err);
  });
}

function showCompletionNotification(session: { cwd: string; models: string[] }): void {
  const project = session.cwd.split('/').filter(Boolean).pop() ?? session.cwd;
  const model = session.models[0] ?? 'session';
  const provider = model.includes('claude') ? 'Claude' : model.includes('gpt') ? 'Codex' : model.includes('qwen') || model.includes('glm') ? 'Qwen' : model;
  const title = `${provider} in ${project}`;
  const body = 'Done — waiting for input';
  const n = new Notification({ title, body });
  n.on('click', () => {
    shell.showItemInFolder(session.cwd);
  });
  n.show();
}

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
  let desired: IconState = 'idle';
  if (hasWaiting) desired = 'waiting';
  else if (hasRunning) desired = 'running';

  // If a linger is pending and we're going back to running, cancel it
  if (lingerTimer && desired === 'running') {
    clearTimeout(lingerTimer);
    lingerTimer = null;
    pendingState = null;
    pendingWaiting = [];
  }

  if (desired !== lastIconState) {
    // Linger: delay running → waiting/idle by 4s to prevent flicker
    if (lastIconState === 'running' && desired !== 'running') {
      if (!lingerTimer) {
        pendingState = desired;
        pendingWaiting = snap.sessions.active.filter(s => s.state === 'waiting-for-input');
        lingerTimer = setTimeout(() => {
          lingerTimer = null;
          applyTrayState(pendingState!);
          if (pendingState === 'waiting') {
            for (const s of pendingWaiting) showCompletionNotification(s);
          }
          pendingState = null;
          pendingWaiting = [];
        }, 4000);
      }
      return; // don't switch yet
    }

    applyTrayState(desired);
  }

  paintTray(lastIconState);
}

function applyTrayState(state: IconState): void {
  const tray = mb?.tray;
  if (!tray) return;
  if (lastIconState === 'running' && state === 'waiting') {
    playCompletionSound();
  }
  lastIconState = state;
  tray.setToolTip(TOOLTIPS[state]);

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

  // Per-dir "estimate cost" toggle: omitted defaults to ON; explicit false hides
  // the $ figures for that dir. Cost is computed here (main process) because it
  // knows each dir's setting and per-dir tokens — the renderer just displays.
  const costEnabledFor = (dirPath: string): boolean => {
    const d = dirs.find(x => x.path === dirPath);
    return d ? d.estimateCost !== false : true;
  };

  const todayModels = store.dayModelByDir(todayKey());
  let todayCost = 0;
  let anyCostEnabled = false;
  for (const d of dirs) {
    if (d.estimateCost === false) continue;
    anyCostEnabled = true;
    todayCost += costOfModels(todayModels.get(d.path) ?? {});
  }
  snap.todayCost = anyCostEnabled ? todayCost : null;

  for (const s of [...snap.sessions.active, ...snap.sessions.recent]) {
    s.cost = costEnabledFor(s.dir) ? costOfModels(s.byModel) : null;
  }

  // Fan out per-dir quota fetches in parallel; quota module handles
  // per-provider routing and 60s caching. Codex gets rate limits from
  // session events via the store instead of an API call.
  const isCodexDir = (p: string) => p.includes('.codex/sessions') || p.includes('.codex\\sessions');
  const plans: DirPlan[] = await Promise.all(
    byDir.map(async d => {
      const plan = isCodexDir(d.path)
        ? store.getCodexQuota(d.path)
        : await getQuotaForDir(d.path);
      // When no live quota is available, degrade to a file-based estimate:
      // utilization derived from rolling token counts against configured caps.
      return { dir: d.path, label: d.label, plan: plan ?? estimatePlan(d, config) };
    })
  );
  snap.limits.plans = plans.filter(p => p.plan != null);
  return snap;
}

function estimatePlan(d: DirLimits, config: Config): PlanQuota | null {
  const fiveHourCap = d.fiveHourTokens ?? config.limits?.fiveHourTokens;
  const weeklyCap = d.weeklyTokens ?? config.limits?.weeklyTokens;
  const fiveHour = fiveHourCap && d.fiveHourUsed > 0
    ? { utilization: Math.min((d.fiveHourUsed / fiveHourCap) * 100, 100), resetsAt: null }
    : null;
  const sevenDay = weeklyCap && d.weeklyUsed > 0
    ? { utilization: Math.min((d.weeklyUsed / weeklyCap) * 100, 100), resetsAt: null }
    : null;
  if (!fiveHour && !sevenDay) return null;
  return {
    fetchedAt: new Date().toISOString(),
    provider: 'anthropic',
    subscription: 'estimated',
    fiveHour,
    sevenDay,
    sevenDayOpus: null,
  };
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
  checkThresholdAlerts(snap);
}

/** Stable key over the set of normalized dir paths (ignores labels/limits/cost). */
function dirSetKey(config: Config): string {
  return dirsFromConfig(config).map(d => d.path).sort().join('\n');
}

const THRESHOLDS = [75, 95] as const;
const firedThresholds = new Set<string>();

function checkThresholdAlerts(snap: StoreSnapshot): void {
  const byDir = snap.limits.byDir ?? [];
  for (const d of byDir) {
    const checks: Array<{ label: string; used: number; cap?: number }> = [
      { label: `${d.label} 5h`, used: d.fiveHourUsed, cap: d.fiveHourTokens },
      { label: `${d.label} 7d`, used: d.weeklyUsed, cap: d.weeklyTokens },
    ];
    for (const c of checks) {
      if (!c.cap) continue;
      const pct = (c.used / c.cap) * 100;
      for (const t of THRESHOLDS) {
        const key = `${d.path}|${c.label}|${t}`;
        if (pct >= t) {
          if (!firedThresholds.has(key)) {
            firedThresholds.add(key);
            const n = new Notification({
              title: `llmusage: ${t}% threshold`,
              body: `${c.label} at ${pct.toFixed(0)}% (${c.used.toLocaleString()} / ${c.cap.toLocaleString()} tok)`,
            });
            n.show();
          }
        } else {
          firedThresholds.delete(key);
        }
      }
    }
  }
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
      const prevConfig = await loadConfig();
      const config = await saveConfig(partial);
      // Full rescan only when the SET of normalized dir paths changed (add/remove/
      // reorder). Metadata-only edits (labels, limits, per-dir cost) just repaint.
      const dirsChanged =
        Object.prototype.hasOwnProperty.call(partial, 'dataDirs') &&
        dirSetKey(prevConfig) !== dirSetKey(config);
      if (dirsChanged) {
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
}).catch((err) => {
  console.error('[llmusage] Fatal startup error:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  // Don't quit — menu bar apps stay alive
});
