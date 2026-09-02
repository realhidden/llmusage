import type { StoreSnapshot, TaskView, TaskPoint } from '../../shared/types.js';
import { formatCompact } from '../components/token-bar.js';

/** Progress reports needed before an ETA is shown; mirrors main's eta.ts. */
const MIN_PROGRESS_REPORTS = 2;

/** Task ids whose detail (charts, note, source) is expanded. */
const expanded = new Set<string>();
/** Task ids whose subtask list is expanded. Collapsed by default. */
const childrenOpen = new Set<string>();

export function renderTasks(container: HTMLElement, snapshot: StoreSnapshot): void {
  const tasks = snapshot.tasks ?? [];
  // The panel only exists while something is registered — no empty shell.
  container.hidden = tasks.length === 0;
  if (tasks.length === 0) {
    container.innerHTML = '';
    return;
  }

  const flat = flatten(tasks);
  const running = flat.filter(t => t.status === 'running' && !t.stale).length;
  const finished = flat.filter(t => t.status === 'done' || t.status === 'failed').length;

  container.innerHTML = `
    <div class="panel-label">
      TASKS
      <span class="tasks-count">${running > 0 ? `${running} running` : `${flat.length} registered`}</span>
      ${finished > 0 ? '<button type="button" class="tasks-clear" id="tasks-clear" title="Clear finished tasks">clear done</button>' : ''}
    </div>
    <div class="tasks-list">${tasks.map(t => taskCard(t)).join('')}</div>`;

  container.querySelector('#tasks-clear')?.addEventListener('click', () => {
    window.api.invoke('tasks:clearFinished');
  });

  for (const head of container.querySelectorAll<HTMLElement>('[data-task-toggle]')) {
    head.addEventListener('click', () => {
      const id = head.dataset.taskToggle!;
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
      renderTasks(container, snapshot);
    });
  }

  for (const btn of container.querySelectorAll<HTMLElement>('[data-task-children]')) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = btn.dataset.taskChildren!;
      if (childrenOpen.has(id)) childrenOpen.delete(id);
      else childrenOpen.add(id);
      renderTasks(container, snapshot);
    });
  }

  for (const btn of container.querySelectorAll<HTMLElement>('[data-task-bell]')) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      window.api.invoke('tasks:setNotify', {
        id: btn.dataset.taskBell!,
        enabled: btn.dataset.bellOn !== 'true',
      });
    });
  }

  for (const btn of container.querySelectorAll<HTMLElement>('[data-task-remove]')) {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      window.api.invoke('tasks:delete', { id: btn.dataset.taskRemove! });
    });
  }
}

function taskCard(task: TaskView): string {
  const open = expanded.has(task.id);
  const pct = task.pct;
  const isChild = task.depth > 0;

  return `
    <div class="task-card${isChild ? ' task-child' : ''}${task.stale ? ' task-stale' : ''}" data-depth="${task.depth}">
      <div class="task-head" data-task-toggle="${escapeAttr(task.id)}" role="button" tabindex="0" aria-expanded="${open}">
        <span class="task-dot ${statusClass(task)}"></span>
        <span class="task-title" title="${escapeAttr(task.id)}">${escapeHtml(task.title)}</span>
        ${statusTag(task)}
        ${task.notifyOnFinish ? '<span class="task-bell-on" title="Dings when this task finishes">\u{1F514}</span>' : ''}
        <span class="task-pct">${pct == null ? '—' : `${pct.toFixed(0)}%`}</span>
        <span class="task-caret">${open ? '▾' : '▸'}</span>
      </div>
      <div class="task-bar" title="${escapeAttr(countsLabel(task) ?? '')}">
        <span class="task-bar-fill ${statusClass(task)}" style="width:${pct == null ? 0 : pct}%"></span>
      </div>
      <div class="task-meta">${metaLine(task)}</div>
      ${task.note ? `<div class="task-note">${escapeHtml(task.note)}</div>` : ''}
      ${open ? taskDetail(task) : ''}
      ${childrenSection(task)}
    </div>`;
}

/** Subtasks are collapsed by default: a summary line opens them. */
function childrenSection(task: TaskView): string {
  const kids = task.children;
  if (kids.length === 0) return '';
  const open = childrenOpen.has(task.id);
  const running = kids.filter(k => k.status === 'running').length;
  const done = kids.filter(k => k.status === 'done').length;
  const summary = [
    `${kids.length} subtask${kids.length === 1 ? '' : 's'}`,
    running > 0 ? `${running} running` : null,
    done > 0 ? `${done} done` : null,
  ].filter(Boolean).join(' · ');

  return `
    <button type="button" class="task-children-toggle" data-task-children="${escapeAttr(task.id)}" aria-expanded="${open}">
      <span class="task-caret">${open ? '▾' : '▸'}</span>${escapeHtml(summary)}
    </button>
    ${open ? `<div class="task-children">${kids.map(c => taskCard(c)).join('')}</div>` : ''}`;
}

function taskDetail(task: TaskView): string {
  const rate = task.ratePerSec != null ? formatRate(task.ratePerSec, task.unit) : null;
  const facts = [
    rate ? `rate ${rate}` : null,
    etaSource(task),
    task.status === 'running' ? `stale after ${formatRelative(task.ttlSeconds * 1000)} without an update` : null,
    task.source ? escapeHtml(task.source) : null,
    `id ${escapeHtml(task.id)}`,
  ].filter(Boolean);

  return `
    <div class="task-detail">
      ${progressChart(task)}
      ${etaChart(task)}
      <div class="task-facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
      <div class="task-detail-actions">
        <button type="button" class="task-bell${task.notifyOnFinish ? ' on' : ''}"
                data-task-bell="${escapeAttr(task.id)}" data-bell-on="${task.notifyOnFinish}"
                aria-pressed="${task.notifyOnFinish}"
                title="Play a sound when this task finishes">
          \u{1F514} ${task.notifyOnFinish ? 'ding on finish: on' : 'ding on finish: off'}
        </button>
        <button type="button" class="task-remove" data-task-remove="${escapeAttr(task.id)}">Remove</button>
      </div>
    </div>`;
}

function etaSource(task: TaskView): string | null {
  if (task.etaAt) return 'eta: reported by the job';
  if (task.etaComputed) return 'eta: derived from rate';
  if (task.total == null) return 'eta: needs a total';
  return `eta: needs ${MIN_PROGRESS_REPORTS - task.progressReports} more progress report${MIN_PROGRESS_REPORTS - task.progressReports === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------- meta --- */

function metaLine(task: TaskView): string {
  const parts: string[] = [];
  const counts = countsLabel(task);
  if (counts) parts.push(counts);
  parts.push(`started ${formatRelative(Date.now() - Date.parse(task.startedAt))} ago`);

  if (task.status === 'running') {
    const eta = task.etaEffective ? Date.parse(task.etaEffective) : null;
    if (eta != null && !Number.isNaN(eta)) {
      const left = eta - Date.now();
      parts.push(left > 0
        ? `eta ${formatClock(eta)} · in ${formatRelative(left)}`
        : `eta ${formatClock(eta)} · overdue`);
    } else if (task.total != null && task.progressReports < MIN_PROGRESS_REPORTS) {
      // One report only measures the gap from registration, which is not a rate.
      parts.push('eta after next update');
    } else {
      parts.push('eta unknown');
    }
    if (task.stale) parts.push(`no update for ${formatRelative(Date.now() - Date.parse(task.updatedAt))}`);
  } else {
    parts.push(`${task.status} ${formatRelative(Date.now() - Date.parse(task.updatedAt))} ago`);
  }

  return parts.map(p => `<span>${escapeHtml(p)}</span>`).join('');
}

export function countsLabel(task: TaskView): string | null {
  if (task.total != null) {
    return `${formatCompact(task.current)} / ${formatCompact(task.total)}${task.unit ? ` ${task.unit}` : ''}`;
  }
  if (task.current > 0) {
    return `${formatCompact(task.current)}${task.unit ? ` ${task.unit}` : ''}`;
  }
  return null;
}

function statusClass(task: TaskView): string {
  if (task.status === 'done') return 'done';
  if (task.status === 'failed') return 'failed';
  if (task.status === 'paused') return 'paused';
  return task.stale ? 'stale' : 'running';
}

function statusTag(task: TaskView): string {
  const cls = statusClass(task);
  if (cls === 'running') return '';
  const label = cls === 'stale' ? 'stale' : task.status;
  const title = cls === 'stale'
    ? `No update for ${formatRelative(Date.now() - Date.parse(task.updatedAt))}; this task reports every ${formatRelative(task.ttlSeconds * 1000)} or less`
    : '';
  return `<span class="task-tag ${cls}" title="${escapeAttr(title)}">${label}</span>`;
}

/* ----------------------------------------------------------------- charts --- */

const CHART_W = 100;
const CHART_H = 30;
const PAD_Y = 2;

/** Progress over time: solid line of samples, dashed projection to the ETA. */
function progressChart(task: TaskView): string {
  const history = task.history;
  if (history.length < 2) {
    return '<div class="task-chart-empty">progress chart appears after a few updates</div>';
  }

  // Without a total, plot raw counts scaled to the highest sample seen.
  const usePct = history.some(p => p.pct != null);
  const peak = Math.max(...history.map(p => p.current), 1);
  const valueOf = (p: TaskPoint) => (usePct ? p.pct ?? 0 : (p.current / peak) * 100);

  const t0 = Math.min(Date.parse(task.startedAt), Date.parse(history[0]!.t));
  const nowMs = Date.now();
  const rawEta = task.etaEffective ? Date.parse(task.etaEffective) : null;
  const etaMs = rawEta != null && !Number.isNaN(rawEta) ? rawEta : null;
  const lastT = Date.parse(history[history.length - 1]!.t);

  // The axis is anchored on observed samples: a distant ETA would otherwise
  // squeeze hours of real progress into a few pixels. The future is capped at
  // a third of the observed span, and the projection clips at the edge.
  const observed = Math.max(lastT, nowMs) - t0;
  const futureCap = Math.max(observed * 0.33, 60_000);
  const wanted = Math.max(etaMs ?? 0, nowMs) - Math.max(lastT, nowMs);
  const tEnd = Math.max(lastT, nowMs) + Math.min(Math.max(wanted, 0), futureCap);
  const span = Math.max(tEnd - t0, 1);
  const x = (ms: number) => ((ms - t0) / span) * CHART_W;
  const y = (v: number) => CHART_H - PAD_Y - (Math.max(0, Math.min(v, 100)) / 100) * (CHART_H - PAD_Y * 2);

  const pts = history.map(p => `${x(Date.parse(p.t)).toFixed(2)},${y(valueOf(p)).toFixed(2)}`);
  const last = history[history.length - 1]!;
  const projection = etaMs != null && task.status === 'running' && usePct
    ? `<line class="task-chart-projection" x1="${x(Date.parse(last.t)).toFixed(2)}" y1="${y(valueOf(last)).toFixed(2)}"
             x2="${x(etaMs).toFixed(2)}" y2="${y(100).toFixed(2)}" vector-effect="non-scaling-stroke" />`
    : '';

  const area = `${x(Date.parse(history[0]!.t)).toFixed(2)},${(CHART_H - PAD_Y).toFixed(2)} ${pts.join(' ')} ${x(Date.parse(last.t)).toFixed(2)},${(CHART_H - PAD_Y).toFixed(2)}`;

  return `
    <div class="task-chart">
      <div class="task-chart-label">${usePct ? 'progress' : `${task.unit ?? 'items'} (relative)`}
        <span>${formatClock(t0)} → ${etaMs != null ? `eta ${formatClock(etaMs)}` : formatClock(tEnd)}</span>
      </div>
      <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" class="task-chart-svg">
        <polygon class="task-chart-area" points="${area}" />
        <polyline class="task-chart-line" points="${pts.join(' ')}" vector-effect="non-scaling-stroke" />
        ${projection}
        <line class="task-chart-now" x1="${x(nowMs).toFixed(2)}" y1="0" x2="${x(nowMs).toFixed(2)}" y2="${CHART_H}" vector-effect="non-scaling-stroke" />
      </svg>
    </div>`;
}

/**
 * ETA drift: the predicted finish instant plotted against when it was
 * predicted. A flat line means a trustworthy estimate; a rising one is
 * a job that keeps slipping.
 */
function etaChart(task: TaskView): string {
  const points = task.history
    .map(p => ({ t: Date.parse(p.t), eta: p.etaAt ? Date.parse(p.etaAt) : NaN }))
    .filter(p => !Number.isNaN(p.eta));
  if (points.length < 2) return '';

  const etas = points.map(p => p.eta);
  let lo = Math.min(...etas);
  let hi = Math.max(...etas);
  if (hi - lo < 60_000) {
    // Near-constant estimate: keep the line visibly flat, mid-height.
    const mid = (lo + hi) / 2;
    lo = mid - 30_000;
    hi = mid + 30_000;
  }
  const t0 = points[0]!.t;
  const tEnd = Math.max(points[points.length - 1]!.t, t0 + 1);
  const x = (ms: number) => ((ms - t0) / (tEnd - t0)) * CHART_W;
  const y = (ms: number) => CHART_H - PAD_Y - ((ms - lo) / (hi - lo)) * (CHART_H - PAD_Y * 2);

  const pts = points.map(p => `${x(p.t).toFixed(2)},${y(p.eta).toFixed(2)}`);
  const drift = points[points.length - 1]!.eta - points[0]!.eta;
  const driftLabel = Math.abs(drift) < 60_000
    ? 'steady'
    : `${drift > 0 ? '+' : '−'}${formatRelative(Math.abs(drift))}`;

  return `
    <div class="task-chart">
      <div class="task-chart-label">eta drift <span>${formatClock(points[0]!.eta)} → ${formatClock(points[points.length - 1]!.eta)} · ${driftLabel}</span></div>
      <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" class="task-chart-svg">
        <polyline class="task-chart-line eta" points="${pts.join(' ')}" vector-effect="non-scaling-stroke" />
      </svg>
    </div>`;
}

/* ---------------------------------------------------------------- helpers --- */

export function flatten(tasks: TaskView[]): TaskView[] {
  const out: TaskView[] = [];
  const walk = (list: TaskView[]): void => {
    for (const t of list) {
      out.push(t);
      walk(t.children);
    }
  };
  walk(tasks);
  return out;
}

export function formatRelative(ms: number): string {
  const secs = Math.max(0, Math.round(ms / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

export function formatRate(perSec: number, unit: string | null): string {
  const name = unit ?? 'items';
  if (perSec >= 1) return `${formatCompact(perSec)} ${name}/s`;
  const perMin = perSec * 60;
  if (perMin >= 1) return `${formatCompact(perMin)} ${name}/min`;
  return `${formatCompact(perSec * 3600)} ${name}/h`;
}

/** HH:MM, prefixed with the weekday when it is not today. */
function formatClock(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  const sameDay = d.toDateString() === new Date().toDateString();
  if (sameDay) return time;
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
  return `${weekday} ${time}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}
