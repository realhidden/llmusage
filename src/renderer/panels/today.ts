import type { StoreSnapshot, DirLimits } from '../../shared/types.js';
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
  const limits = snapshot.limits;
  const byDir = limits.byDir ?? [];

  // Per-tool view if multiple dirs OR any per-dir limit configured
  const hasPerDirLimit = byDir.some(d => d.fiveHourTokens || d.weeklyTokens);
  const usePerDir = byDir.length > 1 || hasPerDirLimit;

  if (usePerDir) {
    return byDir.map(d => renderDirLimit(d)).join('');
  }

  return renderGlobalLimit('5h', limits.fiveHourUsed, limits.fiveHourTokens)
    + renderGlobalLimit('week', limits.weeklyUsed, limits.weeklyTokens);
}

function renderGlobalLimit(label: string, used: number, cap?: number): string {
  if (cap) {
    const pct = Math.min((used / cap) * 100, 100);
    return `
      <div class="limit-row">
        <span class="limit-label">${label}</span>
        <div class="limit-track"><div class="limit-fill ${limitColor(pct)}" style="width:${pct}%"></div></div>
        <span class="limit-text">${Math.round(pct)}% · ${formatCompact(cap)}</span>
      </div>`;
  }
  return `
    <div class="limit-row">
      <span class="limit-label">${label}</span>
      <span class="limit-text" style="margin-left:auto">${formatCompact(used)}</span>
    </div>`;
}

function renderDirLimit(d: DirLimits): string {
  const fivePct = d.fiveHourTokens ? Math.min((d.fiveHourUsed / d.fiveHourTokens) * 100, 100) : null;
  const weekPct = d.weeklyTokens ? Math.min((d.weeklyUsed / d.weeklyTokens) * 100, 100) : null;

  const fiveBar = fivePct != null
    ? `<div class="limit-track"><div class="limit-fill ${limitColor(fivePct)}" style="width:${fivePct}%"></div></div>
       <span class="limit-text">${Math.round(fivePct)}%</span>`
    : `<span class="limit-text" style="margin-left:auto">${formatCompact(d.fiveHourUsed)}</span>`;

  const weekBar = weekPct != null
    ? `<div class="limit-track"><div class="limit-fill ${limitColor(weekPct)}" style="width:${weekPct}%"></div></div>
       <span class="limit-text">${Math.round(weekPct)}%</span>`
    : `<span class="limit-text" style="margin-left:auto">${formatCompact(d.weeklyUsed)}</span>`;

  return `
    <div class="limit-dir-row">
      <span class="limit-dir-label">${escapeHtml(d.label)}</span>
      <div class="limit-dir-bars">
        <div class="limit-row"><span class="limit-sub">5h</span>${fiveBar}</div>
        <div class="limit-row"><span class="limit-sub">wk</span>${weekBar}</div>
      </div>
    </div>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
