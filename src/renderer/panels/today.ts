import type { StoreSnapshot, DirLimits, QuotaWindow, PlanQuota } from '../../shared/types.js';
import { formatCompact, bucketTotal, limitColor, modelColor, modelShort } from '../components/token-bar.js';

let detailExpanded = false;

export function renderToday(container: HTMLElement, snapshot: StoreSnapshot): void {
  const today = snapshot.today;
  const tokens = today.tokens;
  const total = bucketTotal(tokens);

  const dateEl = container.querySelector('#today-date') as HTMLElement;
  if (dateEl) {
    dateEl.textContent = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date());
  }

  const barsEl = container.querySelector('#today-bars') as HTMLElement;
  if (barsEl) {
    const segments: Array<{ label: string; cls: string; value: number }> = [
      { label: 'in',  cls: 'input',      value: tokens.input },
      { label: 'out', cls: 'output',     value: tokens.output },
      { label: '↑',   cls: 'cache-up',   value: tokens.cacheCreate },
      { label: '↓',   cls: 'cache-down', value: tokens.cacheRead },
    ];

    let stackedHTML = '';
    if (total > 0) {
      for (const seg of segments) {
        if (seg.value === 0) continue;
        const pct = (seg.value / total) * 100;
        stackedHTML += `<span class="today-stack-seg ${seg.cls}" style="width:${pct}%" title="${seg.label} ${formatCompact(seg.value)}"></span>`;
      }
    }

    const breakdown = segments
      .map(s => `<span class="today-stat"><span class="today-stat-dot ${s.cls}"></span>${s.label} ${formatCompact(s.value)}</span>`)
      .join('');

    const detailHTML = detailExpanded ? renderRollingDetail(snapshot) : '';

    barsEl.innerHTML = `
      <button type="button" class="today-total" id="today-total-btn" aria-expanded="${detailExpanded}">
        <div class="today-stack">${stackedHTML}</div>
        <div class="today-total-num">${formatCompact(total)}</div>
        <span class="today-total-caret">${detailExpanded ? '▾' : '▸'}</span>
      </button>
      <div class="today-breakdown">${breakdown}</div>
      ${detailHTML}`;

    const btn = barsEl.querySelector('#today-total-btn');
    btn?.addEventListener('click', () => {
      detailExpanded = !detailExpanded;
      renderToday(container, snapshot);
    });
  }

  const limitsEl = container.querySelector('#today-limits') as HTMLElement;
  if (limitsEl) {
    limitsEl.innerHTML = renderPlanSection(snapshot.limits.plan ?? null);
  }

  const modelsEl = container.querySelector('#today-models') as HTMLElement;
  if (modelsEl) {
    const entries = Object.entries(today.byModel)
      .filter(([, b]) => bucketTotal(b) > 0)
      .sort((a, b) => bucketTotal(b[1]) - bucketTotal(a[1]));
    modelsEl.innerHTML = entries.length === 0
      ? ''
      : entries.map(([m, b]) =>
          `<span class="model-item"><span class="model-dot" style="background:${modelColor(m)}"></span>${modelShort(m)} ${formatCompact(bucketTotal(b))}</span>`
        ).join('');
  }
}

function renderPlanSection(plan: PlanQuota | null): string {
  if (!plan || (!plan.fiveHour && !plan.sevenDay)) {
    // No quota available (no keychain / off macOS / fetch failed). Hide entirely.
    return '';
  }
  const heading = plan.subscription
    ? `Claude ${capitalize(plan.subscription)}`
    : 'Claude';

  const rows: string[] = [];
  if (plan.fiveHour) rows.push(planRow('5h', plan.fiveHour));
  if (plan.sevenDay) rows.push(planRow('7d', plan.sevenDay));
  if (plan.sevenDayOpus && plan.sevenDayOpus.utilization > 0) {
    rows.push(planRow('opus', plan.sevenDayOpus));
  }
  return `
    <div class="limits-section">
      <div class="limits-heading">${escapeHtml(heading)}</div>
      ${rows.join('')}
    </div>`;
}

function planRow(label: string, w: QuotaWindow): string {
  const pct = Math.max(0, Math.min(w.utilization, 100));
  const reset = w.resetsAt ? `resets ${formatReset(w.resetsAt)}` : '';
  return `
    <div class="limit-row">
      <span class="limit-label">${label}</span>
      <div class="limit-track"><div class="limit-fill ${limitColor(pct)}" style="width:${pct}%"></div></div>
      <span class="limit-pct">${pct.toFixed(0)}%</span>
      <span class="limit-reset" title="${escapeHtml(w.resetsAt ?? '')}">${reset}</span>
    </div>`;
}

function renderRollingDetail(snapshot: StoreSnapshot): string {
  const limits = snapshot.limits;
  const byDir = limits.byDir ?? [];
  const showDirs = byDir.length > 1 || byDir.some(d => d.fiveHourTokens || d.weeklyTokens);

  const rows = showDirs
    ? byDir.flatMap(d => dirRows(d))
    : [
        rollingRow('5h',  limits.fiveHourUsed,  limits.fiveHourTokens),
        rollingRow('7d',  limits.weeklyUsed,    limits.weeklyTokens),
      ];

  return `
    <div class="today-detail">
      <div class="today-detail-heading">Tokens burned (rolling)</div>
      ${rows.join('')}
    </div>`;
}

function dirRows(d: DirLimits): string[] {
  return [
    rollingRow(`${d.label} 5h`, d.fiveHourUsed, d.fiveHourTokens),
    rollingRow(`${d.label} 7d`, d.weeklyUsed,   d.weeklyTokens),
  ];
}

function rollingRow(label: string, used: number, cap?: number): string {
  if (cap) {
    const pct = Math.min((used / cap) * 100, 100);
    return `
      <div class="limit-row">
        <span class="limit-label">${escapeHtml(label)}</span>
        <div class="limit-track"><div class="limit-fill ${limitColor(pct)}" style="width:${pct}%"></div></div>
        <span class="limit-pct">${formatCompact(used)}</span>
        <span class="limit-reset">of ${formatCompact(cap)}</span>
      </div>`;
  }
  return `
    <div class="limit-row">
      <span class="limit-label">${escapeHtml(label)}</span>
      <div class="limit-track"><div class="limit-fill unconfigured" style="width:0%"></div></div>
      <span class="limit-pct">${formatCompact(used)}</span>
      <span class="limit-reset"></span>
    </div>`;
}

function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const r = mins % 60;
    return r ? `${hours}h ${r}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
