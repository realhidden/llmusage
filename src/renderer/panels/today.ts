import type { StoreSnapshot, DirLimits, QuotaWindow, PlanQuota, DirPlan } from '../../shared/types.js';
import { formatCompact, bucketTotal, limitColor } from '../components/token-bar.js';

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
    limitsEl.innerHTML = renderAllPlans(snapshot.limits.plans ?? []);
  }

  const modelsEl = container.querySelector('#today-models') as HTMLElement;
  if (modelsEl) modelsEl.innerHTML = '';
}

function renderAllPlans(plans: DirPlan[]): string {
  const sections = plans
    .filter(p => p.plan && (p.plan.fiveHour || p.plan.sevenDay || p.plan.sevenDayOpus))
    .map(p => renderPlanSection(p.plan!, p.label));
  return sections.join('');
}

function planHeading(plan: PlanQuota, dirLabel: string): string {
  let providerLabel: string;
  switch (plan.provider) {
    case 'anthropic':
      providerLabel = plan.subscription ? `Claude ${capitalize(plan.subscription)}` : 'Claude';
      break;
    case 'z.ai':
      providerLabel = 'Z.AI';
      break;
    case 'zhipu':
      providerLabel = 'Zhipu';
      break;
    default:
      providerLabel = 'Unknown';
  }
  return `${providerLabel} · ${dirLabel}`;
}

function renderPlanSection(plan: PlanQuota, dirLabel: string): string {
  const heading = planHeading(plan, dirLabel);
  const rows: string[] = [];
  if (plan.fiveHour) rows.push(planCircle('5h', plan.fiveHour));
  if (plan.sevenDay) rows.push(planCircle('7d', plan.sevenDay));
  if (plan.sevenDayOpus && plan.sevenDayOpus.utilization > 0) {
    rows.push(planCircle('opus', plan.sevenDayOpus));
  }
  return `
    <div class="limits-section">
      <div class="limits-heading">${escapeHtml(heading)}</div>
      <div class="limit-circles">${rows.join('')}</div>
    </div>`;
}

function planCircle(label: string, w: QuotaWindow): string {
  const pct = Math.max(0, Math.min(w.utilization, 100));
  const clock = w.resetsAt ? formatResetClock(w.resetsAt) : '';
  const tooltip = w.resetsAt ? `resets ${formatResetFull(w.resetsAt)}` : '';
  return `
    <div class="limit-circle-card" title="${escapeHtml(tooltip)}">
      <div class="limit-ring ${limitColor(pct)}" style="--pct:${pct}">
        <span>${pct.toFixed(0)}</span>
      </div>
      <div class="limit-circle-meta">
        <span class="limit-circle-label">${label}</span>
        <span class="limit-circle-reset">${clock}</span>
      </div>
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
      <div class="today-detail-heading">Rolling burn</div>
      <div class="burn-grid">${rows.join('')}</div>
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
      <div class="burn-card">
        <span class="burn-label">${escapeHtml(label)}</span>
        <span class="burn-value">${formatCompact(used)}</span>
        <span class="burn-caption">${pct.toFixed(0)}% of ${formatCompact(cap)}</span>
      </div>`;
  }
  return `
    <div class="burn-card">
      <span class="burn-label">${escapeHtml(label)}</span>
      <span class="burn-value">${formatCompact(used)}</span>
      <span class="burn-caption">no cap</span>
    </div>`;
}

function formatResetClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function formatResetFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
