import type { StoreSnapshot } from '../../shared/types.js';
import { formatCompact, bucketTotal, modelColor } from '../components/token-bar.js';

const MODEL_ORDER = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'];

export function renderWeek(container: HTMLElement, snapshot: StoreSnapshot): void {
  const chartEl = container.querySelector('#week-chart') as HTMLElement;
  if (!chartEl) return;

  const days = snapshot.last7Days;
  const maxTotal = Math.max(...days.map(d => bucketTotal(d.bucket.tokens)), 1);

  chartEl.innerHTML = '';

  for (const { day, bucket } of days) {
    const group = document.createElement('div');
    group.className = 'week-bar-group';

    const stack = document.createElement('div');
    stack.className = 'week-bar-stack';

    const total = bucketTotal(bucket.tokens);
    if (total === 0) {
      const empty = document.createElement('div');
      empty.className = 'week-bar-segment empty';
      stack.appendChild(empty);
    } else {
      // Sort models by MODEL_ORDER
      const models = Object.entries(bucket.byModel).sort((a, b) => {
        const ai = MODEL_ORDER.indexOf(a[0]);
        const bi = MODEL_ORDER.indexOf(b[0]);
        return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      });

      for (const [model, modelBucket] of models) {
        const seg = document.createElement('div');
        seg.className = 'week-bar-segment';
        const pct = (bucketTotal(modelBucket) / maxTotal) * 100;
        seg.style.height = `${pct}%`;
        seg.style.background = modelColor(model);
        seg.title = `${model}: ${formatCompact(bucketTotal(modelBucket))}`;
        stack.appendChild(seg);
      }
    }

    group.appendChild(stack);

    const label = document.createElement('div');
    label.className = 'week-day';
    const d = new Date(day + 'T12:00:00');
    label.textContent = new Intl.DateTimeFormat('en', { weekday: 'short' }).format(d);
    group.appendChild(label);

    group.title = `${day}: ${formatCompact(total)}`;
    chartEl.appendChild(group);
  }
}
