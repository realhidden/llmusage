import type { UsageBucket, StoreSnapshot } from '../../shared/types.js';
import { formatCompact, bucketTotal, limitColor } from '../components/token-bar.js';

type TokenBarDef = {
  label: string;
  value: number;
  cssClass: string;
};

const BARS: TokenBarDef[] = [
  { label: 'input', value: 0, cssClass: 'input' },
  { label: 'output', value: 0, cssClass: 'output' },
  { label: 'cache↑', value: 0, cssClass: 'cache-up' },
  { label: 'cache↓', value: 0, cssClass: 'cache-down' },
];

export function renderToday(container: HTMLElement, snapshot: StoreSnapshot): void {
  const today = snapshot.today;
  const tokens = today.tokens;
  const maxVal = Math.max(tokens.input, tokens.output, tokens.cacheCreate, tokens.cacheRead, 1);

  // Date
  const dateEl = container.querySelector('#today-date') as HTMLElement;
  if (dateEl) {
    const todayStr = new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
    }).format(new Date());
    dateEl.textContent = todayStr;
  }

  // Token bars
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
        </div>
      `;
    }
  }

  // Limits
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
        </div>
      `;
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
        </div>
      `;
    }
  }

  // Models
  const modelsEl = container.querySelector('#today-models') as HTMLElement;
  if (modelsEl && Object.keys(today.byModel).length > 0) {
    modelsEl.innerHTML = '<div class="model-list">' +
      Object.entries(today.byModel).map(([model, bucket]) => {
        const color = modelColor(model);
        const total = bucketTotal(bucket);
        const short = model.replace('claude-', '').replace('-20251001', '');
        return `<div class="model-item">
          <span class="model-dot" style="background:${color}"></span>
          ${short} ${formatCompact(total)}
        </div>`;
      }).join('') +
      '</div>';
  }
}

function modelColor(model: string): string {
  const colors: Record<string, string> = {
    'claude-opus-4-7': '#89b4fa',
    'claude-sonnet-4-6': '#a6e3a1',
    'claude-haiku-4-5': '#f9e2af',
    'claude-haiku-4-5-20251001': '#f9e2af',
  };
  return colors[model] ?? '#cba6f7';
}
