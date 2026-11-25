import type { StoreSnapshot, DirLimits, QuotaWindow, PlanQuota, DirPlan } from '../../shared/types.js';
import { formatCompact, bucketTotal, limitColor } from '../components/token-bar.js';
import { escapeHtml } from '../components/html.js';

/** Both detail views are behind icons in the panel label; closed by default. */
let burnExpanded = false;
let limitsExpanded = false;

export function renderToday(container: HTMLElement, snapshot: StoreSnapshot): void {
  const today = snapshot.today;
  const tokens = today.tokens;
  const total = bucketTotal(tokens);

  const dateEl = container.querySelector('#today-date') as HTMLElement;
  if (dateEl) {
    dateEl.textContent = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date());
  }

  const togglesEl = container.querySelector('#today-toggles') as HTMLElement;
  if (togglesEl) {
    togglesEl.innerHTML = `
      <button type="button" class="today-icon${limitsExpanded ? ' active' : ''}" id="today-limits-btn"
              aria-pressed="${limitsExpanded}" title="Per-model quota and reset windows">◔</button>
      <button type="button" class="today-icon${burnExpanded ? ' active' : ''}" id="today-burn-btn"
              aria-pressed="${burnExpanded}" title="Rolling burn: 5h and 7d usage against caps">⤵</button>`;

    togglesEl.querySelector('#today-limits-btn')?.addEventListener('click', () => {
      limitsExpanded = !limitsExpanded;
      renderToday(container, snapshot);
    });
    togglesEl.querySelector('#today-burn-btn')?.addEventListener('click', () => {
      burnExpanded = !burnExpanded;
      renderToday(container, snapshot);
    });
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

    // The bar itself is always visible; the two detail views sit behind icons.
    barsEl.innerHTML = `
      <div class="today-total">
        <div class="today-stack">${stackedHTML}</div>
        <div class="today-total-num">${formatCompact(total)}</div>
      </div>
      <div class="today-breakdown">${breakdown}</div>`;
  }

  const limitsEl = container.querySelector('#today-limits') as HTMLElement;
  if (limitsEl) {
    limitsEl.innerHTML = limitsExpanded ? renderAllPlans(snapshot.limits.plans ?? []) : '';
  }

  const burnEl = container.querySelector('#today-burn') as HTMLElement;
  if (burnEl) {
    burnEl.innerHTML = burnExpanded ? renderRollingDetail(snapshot) : '';
  }
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
  const plans = limits.plans ?? [];
  const showDirs = byDir.length > 1 || byDir.some(d => d.fiveHourTokens || d.weeklyTokens);

  const rows = showDirs
    ? byDir.flatMap(d => dirRows(d, plans.find(p => p.dir === d.path)?.plan ?? null))
    : [
        rollingRow('5h',  limits.fiveHourUsed,  limits.fiveHourTokens, null, 5 * 3600_000),
        rollingRow('7d',  limits.weeklyUsed,    limits.weeklyTokens, null, 7 * 86400_000),
      ];

  return `
    <div class="today-detail">
      <div class="today-detail-heading">Rolling burn</div>
      <div class="burn-grid">${rows.join('')}</div>
    </div>`;
}

function dirRows(d: DirLimits, plan: DirPlan['plan'] = null): string[] {
  return [
    rollingRow(`${d.label} 5h`, d.fiveHourUsed, d.fiveHourTokens, plan?.fiveHour?.resetsAt ?? null, 5 * 3600_000),
    rollingRow(`${d.label} 7d`, d.weeklyUsed,   d.weeklyTokens,   plan?.sevenDay?.resetsAt ?? null, 7 * 86400_000),
  ];
}

function rollingRow(label: string, used: number, cap?: number, resetsAt?: string | null, windowMs?: number): string {
  const countdown = resetsAt ? formatCountdown(resetsAt) : null;
  const pace = paceProjection(used, cap, windowMs);
  if (cap) {
    const pct = Math.min((used / cap) * 100, 100);
    return `
      <div class="burn-card">
        <span class="burn-label">${escapeHtml(label)}</span>
        <span class="burn-value">${formatCompact(used)}</span>
        <span class="burn-caption">${pct.toFixed(0)}% of ${formatCompact(cap)}${countdown ? ` · resets in ${countdown}` : ''}${pace ? ` · ${pace}` : ''}</span>
      </div>`;
  }
  return `
    <div class="burn-card">
      <span class="burn-label">${escapeHtml(label)}</span>
      <span class="burn-value">${formatCompact(used)}</span>
      <span class="burn-caption">${countdown ? `resets in ${countdown}` : 'no cap'}${pace ? ` · ${pace}` : ''}</span>
    </div>`;
}

function paceProjection(used: number, cap: number | undefined, windowMs?: number): string | null {
  if (!cap || !windowMs || used === 0) return null;
  const remaining = cap - used;
  if (remaining <= 0) return 'exhausted';
  const windowHours = windowMs / 3600_000;
  const ratePerHour = used / windowHours;
  const hoursToEmpty = remaining / ratePerHour;
  if (hoursToEmpty >= windowHours) return null; // won't deplete before window resets
  const h = Math.floor(hoursToEmpty);
  const m = Math.round((hoursToEmpty - h) * 60);
  return `~${h}h${m > 0 ? ` ${m}m` : ''} left at pace`;
}

function formatCountdown(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const diffMs = d.getTime() - Date.now();
  if (diffMs <= 0) return 'now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
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
