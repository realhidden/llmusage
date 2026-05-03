import type { StoreSnapshot } from '../shared/types.js';
import { renderToday } from './panels/today.js';
import { renderWeek } from './panels/week.js';
import { renderSessions } from './panels/sessions.js';
import { formatCompact, bucketTotal } from './components/token-bar.js';

let lastSnapshot: StoreSnapshot | null = null;

const app = document.getElementById('app')!;
const headerToday = document.getElementById('header-today') as HTMLElement;
const headerWaiting = document.getElementById('header-waiting') as HTMLElement;
const statusDot = document.getElementById('status-dot') as HTMLElement;

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
const unsub = (window as any).api.subscribe('store:update', (snap: StoreSnapshot) => {
  lastSnapshot = snap;
  render(snap);
});

// Request initial snapshot
(window as any).api.invoke('store:snapshot').then((snap: StoreSnapshot) => {
  lastSnapshot = snap;
  render(snap);
}).catch((err: Error) => {
  console.error('Failed to get initial snapshot:', err);
  const panels = document.getElementById('panels');
  if (panels) {
    panels.innerHTML = '<div class="empty-state">Loading…</div>';
  }
});
