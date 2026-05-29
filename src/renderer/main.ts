import type { Config, StoreSnapshot, UpdateCheckResult } from '../shared/types.js';
import { renderToday } from './panels/today.js';
import { renderWeek } from './panels/week.js';
import { renderSessions } from './panels/sessions.js';
import { toggleSettings } from './panels/settings.js';
import { formatCompact, bucketTotal } from './components/token-bar.js';

let lastSnapshot: StoreSnapshot | null = null;

const appEl = document.getElementById('app')!;
const headerToday = document.getElementById('header-today') as HTMLElement;
const headerWaiting = document.getElementById('header-waiting') as HTMLElement;
const statusDot = document.getElementById('status-dot') as HTMLElement;
const quitBtn = document.getElementById('header-quit') as HTMLElement;
const gearBtn = document.getElementById('header-gear') as HTMLElement;
const refreshBtn = document.getElementById('header-refresh') as HTMLElement;
const updateBanner = document.getElementById('update-banner') as HTMLElement;

function applyTheme(theme: Config['theme'] = 'system'): void {
  document.body.dataset.theme = theme;
}

window.api.invoke('config:get').then((config) => {
  window.__llmusageConfig = config;
  applyTheme(config.theme ?? 'system');
});

quitBtn?.addEventListener('click', () => {
  window.api.invoke('app:quit');
});

refreshBtn?.addEventListener('click', () => {
  refreshBtn.classList.add('spinning');
  window.api.invoke('store:snapshot').then((snap: StoreSnapshot) => {
    lastSnapshot = snap;
    render(snap);
    setTimeout(() => refreshBtn.classList.remove('spinning'), 200);
  });
});

gearBtn?.addEventListener('click', () => {
  toggleSettings(appEl);
});

function renderUpdateBanner(update: UpdateCheckResult): void {
  if (!update.updateAvailable || !update.latestVersion || !update.releaseUrl) {
    updateBanner.hidden = true;
    updateBanner.innerHTML = '';
    return;
  }
  updateBanner.hidden = false;
  updateBanner.innerHTML = `
    <span>Update ${escapeHtml(update.latestVersion)} available</span>
    <button type="button" data-action="download">Download</button>
    <button type="button" data-action="dismiss" title="Dismiss">&times;</button>
  `;
  updateBanner.querySelector('[data-action="download"]')?.addEventListener('click', () => {
    window.api.invoke('app:openUpdate', { url: update.releaseUrl! });
  });
  updateBanner.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => {
    updateBanner.hidden = true;
  });
}

function checkForUpdates(): void {
  window.api.invoke('app:checkUpdate').then(renderUpdateBanner).catch((err: Error) => {
    console.warn('Update check failed:', err);
  });
}

function updateHeader(snap: StoreSnapshot): void {
  const total = bucketTotal(snap.today.tokens);
  headerToday.textContent = `today: ${formatCompact(total)} tok`;

  const waiting = snap.sessions.active.filter(s => s.state === 'waiting-for-input').length;
  if (waiting > 0) {
    headerWaiting.style.display = '';
    headerWaiting.textContent = `${waiting} waiting`;
  } else {
    headerWaiting.style.display = 'none';
  }

  const hasRunning = snap.sessions.active.some(s => s.state === 'running');
  const hasWaiting = snap.sessions.active.some(s => s.state === 'waiting-for-input');
  statusDot.className = 'status-dot';
  if (hasRunning) statusDot.classList.add('running');
  else if (hasWaiting) statusDot.classList.add('waiting');
}

function render(snap: StoreSnapshot): void {
  updateHeader(snap);

  const todayEl = document.getElementById('panel-today')!;
  renderToday(todayEl, snap);

  const weekEl = document.getElementById('panel-week')!;
  renderWeek(weekEl, snap);

  const sessionsEl = document.getElementById('panel-sessions')!;
  renderSessions(sessionsEl, snap);
}

// Subscribe to store updates
const unsub = window.api.subscribe('store:update', (snap: StoreSnapshot) => {
  lastSnapshot = snap;
  render(snap);
});

// Request initial snapshot
window.api.invoke('store:snapshot').then((snap: StoreSnapshot) => {
  lastSnapshot = snap;
  render(snap);
  checkForUpdates();
}).catch((err: Error) => {
  console.error('Failed to get initial snapshot:', err);
  const panels = document.getElementById('panels');
  if (panels) {
    panels.innerHTML = '<div class="empty-state">Loading…</div>';
  }
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
