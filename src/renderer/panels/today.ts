import type { UsageBucket, StoreSnapshot } from '../../shared/types.js';
import { formatCompact, bucketTotal, limitColor } from '../components/token-bar.js';

const BARS = [
  { label: 'input', cssClass: 'input' },
  { label: 'output', cssClass: 'output' },
  { label: 'cache↑', cssClass: 'cache-up' },
  { label: 'cache↓', cssClass: 'cache-down' },
];

export function renderToday(container: HTMLElement, snapshot: StoreSnapshot): void {
  const today = snapshot.today;
  const tokens = today.tokens;
  const maxVal = Math.max(tokens.input, tokens.output, tokens.cacheCreate, tokens.cacheRead, 1);

  const dateEl = container.querySelector('#today-date') as HTMLElement;
  if (dateEl) {
    dateEl.textContent = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date());
  }

  const barsEl = container.querySelector('#today-bars') as HTMLElement;
  if (barsEl) {
    const values = [tokens.input, tokens.output, tokens.cacheCreate, tokens.cacheRead];
    barsEl.innerHTML = '';
    for (let i = 0; i < BARS.length; i++) {
      const def = BARS[i]!;
      const val = values[i]!;
      const pct = (val / maxVal) * 100;
      barsEl.innerHTML += `
        <div class="token-bar-row">
          <span class="token-bar-label">${def.label}</span>
          <div class="token-bar-track">
            <div class="token-bar-fill ${def.cssClass}" style="width:${pct}%"></div>
          </div>
          <span class="token-bar-value">${formatCompact(val)}</span>
        </div>`;
    }
  }

  // Rolling window usage (always shown)
  const limitsEl = container.querySelector('#today-limits') as HTMLElement;
  if (limitsEl) {
    limitsEl.innerHTML = '';
    const limits = snapshot.limits;

    if (limits.fiveHourTokens) {
      const pct = Math.min((limits.fiveHourUsed / limits.fiveHourTokens) * 100, 100);
      limitsEl.innerHTML += `
        <div class="limit-row">
          <span class="limit-label">5h window</span>
          <div class="limit-track">
            <div class="limit-fill ${limitColor(pct)}" style="width:${pct}%"></div>
          </div>
          <span class="limit-text">${Math.round(pct)}% of ${formatCompact(limits.fiveHourTokens)}</span>
        </div>`;
    } else {
      limitsEl.innerHTML += `
        <div class="limit-row">
          <span class="limit-label">5h window</span>
          <span class="limit-text" style="margin-left:auto">${formatCompact(limits.fiveHourUsed)}</span>
        </div>`;
    }

    if (limits.weeklyTokens) {
      const pct = Math.min((limits.weeklyUsed / limits.weeklyTokens) * 100, 100);
      limitsEl.innerHTML += `
        <div class="limit-row">
          <span class="limit-label">weekly</span>
          <div class="limit-track">
            <div class="limit-fill ${limitColor(pct)}" style="width:${pct}%"></div>
          </div>
          <span class="limit-text">${Math.round(pct)}% of ${formatCompact(limits.weeklyTokens)}</span>
        </div>`;
    } else {
      limitsEl.innerHTML += `
        <div class="limit-row">
          <span class="limit-label">weekly</span>
          <span class="limit-text" style="margin-left:auto">${formatCompact(limits.weeklyUsed)}</span>
        </div>`;
    }
  }

  const modelsEl = container.querySelector('#today-models') as HTMLElement;
  if (modelsEl && Object.keys(today.byModel).length > 0) {
    modelsEl.innerHTML = '<div class="model-list">' +
      Object.entries(today.byModel).map(([model, bucket]) => {
        const total = bucketTotal(bucket);
        const short = modelShort(model);
        return `<div class="model-item">
          <span class="model-dot" style="background:${modelColor(model)}"></span>
          ${short} ${formatCompact(total)}
        </div>`;
      }).join('') +
      '</div>';
  }
}

const MODEL_COLORS: Record<string, string> = {
  'claude-opus-4-7': '#89b4fa',
  'claude-sonnet-4-6': '#a6e3a1',
  'claude-haiku-4-5': '#f9e2af',
  'claude-haiku-4-5-20251001': '#f9e2af',
  'glm-5.1': '#f38ba8',
  'glm-5-turbo': '#fab387',
  'glm-4.5-air': '#94e2d5',
};

export function modelColor(model: string): string {
  return MODEL_COLORS[model] ?? '#cba6f7';
}

export function modelShort(model: string): string {
  const map: Record<string, string> = {
    'claude-opus-4-7': 'opus',
    'claude-sonnet-4-6': 'sonnet',
    'claude-haiku-4-5': 'haiku',
    'claude-haiku-4-5-20251001': 'haiku',
    'glm-5.1': 'glm-5.1',
    'glm-5-turbo': 'glm-5t',
    'glm-4.5-air': 'glm-4.5',
  };
  return map[model] ?? model.replace('claude-', '').replace('-20251001', '');
}
