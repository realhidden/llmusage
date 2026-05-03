import type { StoreSnapshot, DirLimits, QuotaWindow } from '../../shared/types.js';
import { formatCompact, bucketTotal, limitColor, modelColor, modelShort } from '../components/token-bar.js';

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

    barsEl.innerHTML = `
      <div class="today-total">
        <div class="today-stack">${stackedHTML}</div>
        <div class="today-total-num">${formatCompact(total)}</div>
      </div>
      <div class="today-breakdown">${breakdown}</div>`;
  }

  const limitsEl = container.querySelector('#today-limits') as HTMLElement;
  if (limitsEl) {
    limitsEl.innerHTML = renderLimits(snapshot);
  }

  const modelsEl = container.querySelector('#today-models') as HTMLElement;
  if (modelsEl) {
    const entries = Object.entries(today.byModel)
      .filter(([, b]) => bucketTotal(b) > 0)
      .sort((a, b) => bucketTotal(b[1]) - bucketTotal(a[1]));
    if (entries.length === 0) {
      modelsEl.innerHTML = '';
    } else {
      modelsEl.innerHTML = entries.map(([m, b]) =>
        `<span class="model-item"><span class="model-dot" style="background:${modelColor(m)}"></span>${modelShort(m)} ${formatCompact(bucketTotal(b))}</span>`
      ).join('');
    }
  }
}

function renderLimits(snapshot: StoreSnapshot): string {
  const sections: string[] = [];
  const plan = snapshot.limits.plan;
  if (plan && (plan.fiveHour || plan.sevenDay || plan.sevenDayOpus)) {
    sections.push(renderPlanSection(plan));
  }
  sections.push(renderUsageSection(snapshot));
  return sections.join('');
}

function renderPlanSection(plan: NonNullable<StoreSnapshot['limits']['plan']>): string {
  const rows: string[] = [];
  if (plan.fiveHour) rows.push(planRow('5h', plan.fiveHour));
  if (plan.sevenDay) rows.push(planRow('7d', plan.sevenDay));
  if (plan.sevenDayOpus && plan.sevenDayOpus.utilization > 0) {
    rows.push(planRow('opus', plan.sevenDayOpus));
  }
  return `
    <div class="limits-section">
      <div class="limits-heading">Plan</div>
      ${rows.join('')}
    </div>`;
}

function planRow(label: string, w: QuotaWindow): string {
  const pct = Math.max(0, Math.min(w.utilization, 100));
  const reset = w.resetsAt ? formatReset(w.resetsAt) : '';
  return `
    <div class="limit-row">
      <span class="limit-label">${label}</span>
      <div class="limit-track"><div class="limit-fill ${limitColor(pct)}" style="width:${pct}%"></div></div>
      <span class="limit-pct">${pct.toFixed(0)}%</span>
      <span class="limit-reset">${reset}</span>
    </div>`;
}

function renderUsageSection(snapshot: StoreSnapshot): string {
  const limits = snapshot.limits;
  const byDir = limits.byDir ?? [];
  const usePerDir = byDir.length > 1 || byDir.some(d => d.fiveHourTokens || d.weeklyTokens);

  if (usePerDir) {
    return `
      <div class="limits-section">
        <div class="limits-heading">Local usage</div>
        ${byDir.map(d => renderDirRows(d)).join('')}
      </div>`;
  }

  return `
    <div class="limits-section">
      <div class="limits-heading">Local usage</div>
      ${usageRow('5h', limits.fiveHourUsed, limits.fiveHourTokens ?? 200_000)}
      ${usageRow('wk', limits.weeklyUsed, limits.weeklyTokens ?? 2_000_000)}
    </div>`;
}

function renderDirRows(d: DirLimits): string {
  const fiveCap = d.fiveHourTokens ?? 200_000;
  const weekCap = d.weeklyTokens ?? 2_000_000;
  return `
    <div class="limit-row">
      <span class="limit-label">${escapeHtml(d.label)} 5h</span>
      ${barFor(d.fiveHourUsed, fiveCap, !!d.fiveHourTokens)}
    </div>
    <div class="limit-row">
      <span class="limit-label">${escapeHtml(d.label)} wk</span>
      ${barFor(d.weeklyUsed, weekCap, !!d.weeklyTokens)}
    </div>`;
}

function usageRow(label: string, used: number, cap: number, configured = false): string {
  return `
    <div class="limit-row">
      <span class="limit-label">${label}</span>
      ${barFor(used, cap, configured)}
    </div>`;
}

function barFor(used: number, cap: number, configured: boolean): string {
  const pct = Math.min((used / cap) * 100, 100);
  const cls = configured ? limitColor(pct) : 'unconfigured';
  return `
    <div class="limit-track"><div class="limit-fill ${cls}" style="width:${pct}%"></div></div>
    <span class="limit-pct">${formatCompact(used)}</span>
    <span class="limit-reset">${configured ? `of ${formatCompact(cap)}` : ''}</span>`;
}

function formatReset(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const ms = d.getTime() - now.getTime();
  if (ms <= 0) return '';
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
