import { app, ipcMain, shell, Menu, Notification } from 'electron';
import { menubar } from 'menubar';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { Store } from './claude/store.js';
import { Watcher } from './claude/watcher.js';
import { dirsFromConfig, normalizeDir } from './claude/dirs.js';
import { discoverAgentDirs } from './discover.js';
import { loadConfig, saveConfig } from './config.js';
import { registerIPC } from './ipc.js';
import { getIcon, initIcons, type IconState } from './tray-icon.js';
import { getQuotaForDir } from './quota.js';
import { checkForUpdate, isGitHubReleaseUrl } from './update.js';
import { TaskStore } from './tasks/store.js';
import { startProgressServer, DEFAULT_PORT, type ProgressServer } from './tasks/server.js';
import { costOfModels } from '../shared/pricing.js';
import { todayKey } from '../shared/time.js';
import type { StoreSnapshot, Config, DirLimits, DirPlan, PlanQuota, DataDirEntry } from '../shared/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = process.env.NODE_ENV === 'development';

let store: Store;
let watcher: Watcher;
let tasks: TaskStore;
let progressServer: ProgressServer | null = null;
let pruneTimer: ReturnType<typeof setInterval> | null = null;
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
const BROADCAST_DEBOUNCE_MS = 1000;
const TASK_DEBOUNCE_MS = 250;

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
    todayCost += costOfModels(todayModels.get(d.path) ?? {}, config.priceOverrides);
  }
  snap.todayCost = anyCostEnabled ? todayCost : null;

  for (const s of [...snap.sessions.active, ...snap.sessions.recent]) {
    s.cost = costEnabledFor(s.dir) ? costOfModels(s.byModel, config.priceOverrides) : null;
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
  snap.tasks = tasks.view();
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

/**
 * Bring up the loopback progress endpoint. A failure here (port unavailable)
 * must not take the tray app down — usage tracking works without it.
 */
async function startProgress(config: Config): Promise<void> {
  if (config.progress?.enabled === false) return;
  const envPort = Number(process.env.MYSTATUS_PROGRESS_PORT);
  const port = Number.isFinite(envPort) && envPort > 0
    ? envPort
    : config.progress?.port ?? DEFAULT_PORT;
  try {
    progressServer = await startProgressServer({ store: tasks, port, version: app.getVersion() });
    console.log(`[llmusage] progress endpoint on ${progressServer.url}`);
  } catch (err) {
    console.error('[llmusage] progress endpoint failed to start:', err);
  }
}

function createWatcher(config: Config): Watcher {
  const normalizedDirs = dirsFromConfig(config);
  return new Watcher(store, {
    dirs: normalizedDirs.map(d => d.path),
    cache: true,
    onError: (scope, message) => {
      console.error(`[${scope}] ${message}`);
    },
    onProgress: () => scheduleBroadcast(),
  });
}

async function currentSnapshot(): Promise<StoreSnapshot> {
  const config = await loadConfig();
  return decorateSnapshot(store.snapshot(), config);
}

function popupVisible(): boolean {
  const win = mb?.window;
  return win != null && !win.isDestroyed() && win.isVisible();
}

/**
 * Broadcast state.
 *
 * The full snapshot is expensive — 100+ day buckets, per-dir quota fan-out,
 * cost math, then a structured clone across IPC. None of it is observable while
 * the popup is hidden, which is nearly all the time, so when it is closed we do
 * only the cheap part: derive session states for the tray.
 */
async function sendSnapshot(): Promise<void> {
  if (!popupVisible()) {
    const snap = store.snapshot();
    updateTrayIcon(snap);
    checkThresholdAlerts(await decorateLimits(snap));
    return;
  }
  const snap = await currentSnapshot();
  const win = mb?.window;
  if (win && !win.isDestroyed()) {
    win.webContents.send('store:update', snap);
  }
  updateTrayIcon(snap);
  checkThresholdAlerts(snap);
}

/** Just the per-dir rolling totals, for threshold alerts while hidden. */
async function decorateLimits(snap: StoreSnapshot): Promise<StoreSnapshot> {
  const config = await loadConfig();
  snap.limits.byDir = dirsFromConfig(config).map(d => ({
    path: d.path,
    label: d.label,
    fiveHourTokens: d.fiveHourTokens,
    weeklyTokens: d.weeklyTokens,
    fiveHourUsed: store.rollingByDir(d.path, FIVE_HOURS_MS),
    weeklyUsed: store.rollingByDir(d.path, WEEK_MS),
  }));
  return snap;
}

/**
 * Coalesce store and task changes into one broadcast. The old 200 ms cadence
 * re-ran the whole pipeline several times a second during an active session;
 * this view does not need to be real time.
 */
function scheduleBroadcast(delayMs = BROADCAST_DEBOUNCE_MS): void {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    void sendSnapshot();
  }, delayMs);
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

/**
 * Apply a changed dir set on the long-lived watcher: additions are scanned,
 * removals purged — unchanged files are never re-read. Serialized so rapid
 * successive config edits can't interleave scans.
 */
let dirChangeChain: Promise<void> = Promise.resolve();
function scheduleDirChange(config: Config): void {
  const paths = dirsFromConfig(config).map(d => d.path);
  dirChangeChain = dirChangeChain
    .then(async () => {
      await watcher?.setDirs(paths);
      await sendSnapshot();
    })
    .catch(err => {
      console.error('[llmusage] dir change failed:', err);
    });
}

app.whenReady().then(async () => {
  app.dock?.hide();

  // Rasterize tray-icon SVGs once Chromium is ready, before we hand
  // an icon to menubar()
  await initIcons();

  store = new Store();
  tasks = new TaskStore();
  await tasks.load();

  const initConfig = await loadConfig();
  await startProgress(initConfig);
  watcher = createWatcher(initConfig);

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

  // The popup is hidden most of the time and skips broadcasts while it is;
  // repaint it with fresh data the moment it opens.
  mb.on('after-show', () => void sendSnapshot());

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
  store.onChange(() => scheduleBroadcast());

  // Bell-armed tasks ding when they finish. Sound only — no notification, the
  // panel already carries the outcome.
  tasks.onFinish((task) => {
    console.log(`[llmusage] task finished: ${task.id} (${task.status})`);
    playCompletionSound();
  });

  // Task pushes repaint through the same debounced broadcast as usage changes,
  // but promptly — a progress bar that lags a second reads as stuck.
  tasks.onChange(() => scheduleBroadcast(TASK_DEBOUNCE_MS));

  // Expire finished tasks and re-render staleness/ETA countdowns. Nothing to
  // repaint while the popup is closed; prune() emits on its own when it drops one.
  pruneTimer = setInterval(() => {
    if (!tasks.prune() && popupVisible()) void sendSnapshot();
  }, 30_000);

  if (initConfig.autoLaunch) {
    app.setLoginItemSettings({ openAtLogin: true });
  }

  watcher.start();

  // The first scan replays the on-disk aggregate cache, then reads only what
  // changed — newest files first, yielding between them. Deliberately not
  // awaited: the tray and popup are usable while it runs.
  void watcher.coldScan().catch(err => {
    console.error('[llmusage] cold scan failed:', err);
  });

  registerIPC(ipcMain, {
    'store:snapshot': async () => currentSnapshot(),
    'config:get': async () => loadConfig(),
    'discover:dirs': async () => {
      const config = await loadConfig();
      const configured = new Set(dirsFromConfig(config).map(d => d.path));
      const candidates = await discoverAgentDirs();
      return candidates.filter(c => !configured.has(normalizeDir({ path: c.path }).path));
    },
    'config:set': async (_event, args) => {
      const partial = args as Partial<Config>;
      const prevConfig = await loadConfig();
      const config = await saveConfig(partial);
      // Respond immediately — the UI must never wait on a rescan. Dir-set
      // changes (add/remove/reorder) are applied in the background; the
      // resulting snapshot broadcast repaints the data once done.
      const dirsChanged =
        Object.prototype.hasOwnProperty.call(partial, 'dataDirs') &&
        dirSetKey(prevConfig) !== dirSetKey(config);
      if (dirsChanged) {
        scheduleDirChange(config);
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
    'tasks:delete': async (_event, args) => {
      const { id } = args as { id: string };
      tasks.remove(id);
    },
    'tasks:clearFinished': async () => {
      tasks.clearFinished();
    },
    'tasks:setNotify': async (_event, args) => {
      const { id, enabled } = args as { id: string; enabled: boolean };
      tasks.setNotify(id, enabled);
    },
    'tasks:endpoint': async () => {
      const config = await loadConfig();
      return {
        enabled: config.progress?.enabled !== false,
        port: progressServer?.port ?? null,
        url: progressServer?.url ?? null,
        published: progressServer?.published === true,
      };
    },
  });
}).catch((err) => {
  console.error('[llmusage] Fatal startup error:', err);
  app.quit();
});

app.on('window-all-closed', () => {
  // Don't quit — menu bar apps stay alive
});

app.on('before-quit', () => {
  if (pruneTimer) clearInterval(pruneTimer);
  watcher?.stop();
  void progressServer?.close();
  watcher?.saveCacheSync();
  tasks?.saveSync();
});

// A killed app would otherwise leave a stale endpoint.json advertising a port
// nothing listens on. Route signals through quit so cleanup runs.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => app.quit());
}
