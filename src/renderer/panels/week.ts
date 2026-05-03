import type { StoreSnapshot } from '../../shared/types.js';
import { formatCompact, bucketTotal, modelColor, modelShort } from '../components/token-bar.js';

const MODEL_ORDER = ['claude-opus-4-7', 'glm-5.1', 'claude-sonnet-4-6', 'glm-5-turbo', 'claude-haiku-4-5', 'glm-4.5-air'];

const MAX_BAR_PX = 64;

export function renderWeek(container: HTMLElement, snapshot: StoreSnapshot): void {
  const chartEl = container.querySelector('#week-chart') as HTMLElement;
  if (!chartEl) return;

  const days = snapshot.last7Days;
  const totals = days.map(d => bucketTotal(d.bucket.tokens));
  const maxTotal = Math.max(...totals, 1);

  chartEl.innerHTML = '';

  for (let i = 0; i < days.length; i++) {
    const { day, bucket } = days[i]!;
    const total = totals[i]!;

    const group = document.createElement('div');
    group.className = 'week-bar-group';

    const stack = document.createElement('div');
    stack.className = 'week-bar-stack';

    const stackHeightPx = total === 0 ? 3 : Math.max(Math.round((total / maxTotal) * MAX_BAR_PX), 3);
    stack.style.height = `${stackHeightPx}px`;

    if (total > 0) {
      const models = Object.entries(bucket.byModel)
        .filter(([, b]) => bucketTotal(b) > 0)
        .sort((a, b) => {
          const ai = MODEL_ORDER.indexOf(a[0]);
          const bi = MODEL_ORDER.indexOf(b[0]);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });

      const lines: string[] = [`${day} — ${formatCompact(total)} tok`];
      for (const [model, modelBucket] of models) {
        const mTotal = bucketTotal(modelBucket);
        const seg = document.createElement('div');
        seg.className = 'week-bar-segment';
        seg.style.height = `${(mTotal / total) * 100}%`;
        seg.style.background = modelColor(model);
        stack.appendChild(seg);
        lines.push(`  ${modelShort(model)}: ${formatCompact(mTotal)}`);
      }
      stack.title = lines.join('\n');
    } else {
      stack.title = `${day} — 0 tok`;
    }

    group.appendChild(stack);

    const label = document.createElement('div');
    label.className = 'week-day';
    const d = new Date(day + 'T12:00:00');
    label.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d).slice(0, 2);
    group.appendChild(label);

    chartEl.appendChild(group);
  }
}
