import type { StoreSnapshot } from '../../shared/types.js';
import { formatCompact, bucketTotal, modelColor, modelShort } from '../components/token-bar.js';

const MODEL_ORDER = ['claude-opus-4-7', 'glm-5.1', 'claude-sonnet-4-6', 'glm-5-turbo', 'claude-haiku-4-5', 'glm-4.5-air'];

const MAX_BAR_PX = 48;

export function renderWeek(container: HTMLElement, snapshot: StoreSnapshot): void {
  const chartEl = container.querySelector('#week-chart') as HTMLElement;
  if (!chartEl) return;

  const days = snapshot.last7Days;
  const maxTotal = Math.max(...days.map(d => bucketTotal(d.bucket.tokens)), 1);

  chartEl.innerHTML = '';

  for (const { day, bucket } of days) {
    const group = document.createElement('div');
    group.className = 'week-bar-group';

    const total = bucketTotal(bucket.tokens);

    const stack = document.createElement('div');
    stack.className = 'week-bar-stack';

    if (total === 0) {
      stack.style.height = '4px';
      stack.style.background = 'var(--bar-bg)';
      stack.style.borderRadius = '2px';
    } else {
      const models = Object.entries(bucket.byModel).sort((a, b) => {
        const ai = MODEL_ORDER.indexOf(a[0]);
        const bi = MODEL_ORDER.indexOf(b[0]);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      const lines: string[] = [];
      for (const [model, modelBucket] of models) {
        const seg = document.createElement('div');
        seg.className = 'week-bar-segment';
        const px = Math.max(Math.round((bucketTotal(modelBucket) / maxTotal) * MAX_BAR_PX), 2);
        seg.style.height = `${px}px`;
        seg.style.background = modelColor(model);
        lines.push(`${modelShort(model)}: ${formatCompact(bucketTotal(modelBucket))}`);
        stack.appendChild(seg);
      }
      lines.push(`total: ${formatCompact(total)}`);
      stack.title = lines.join('\n');
    }

    group.appendChild(stack);

    const label = document.createElement('div');
    label.className = 'week-day';
    const d = new Date(day + 'T12:00:00');
    label.textContent = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(d);
    group.appendChild(label);

    chartEl.appendChild(group);
  }
}
