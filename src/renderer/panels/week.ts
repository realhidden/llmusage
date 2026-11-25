import type { StoreSnapshot } from '../../shared/types.js';
import { formatCompact, bucketTotal, modelColor, modelShort } from '../components/token-bar.js';
import { escapeHtml } from '../components/html.js';

const MAX_BAR_PX = 64;
type RangeKey = 'last7Days' | 'last30Days' | 'thisMonth' | 'lastMonth' | 'last12Months';

const RANGE_LABELS: Record<RangeKey, string> = {
  last7Days: '7d',
  last30Days: '30d',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  last12Months: '12 mo',
};

let selectedRange: RangeKey = 'last7Days';

export function renderWeek(container: HTMLElement, snapshot: StoreSnapshot): void {
  const chartEl = container.querySelector('#week-chart') as HTMLElement;
  if (!chartEl) return;
  const summaryEl = container.querySelector('#week-summary') as HTMLElement | null;
  const legendEl = container.querySelector('#week-legend') as HTMLElement | null;
  const switchEl = container.querySelector('#range-switch') as HTMLElement | null;

  if (switchEl) {
    switchEl.innerHTML = (Object.keys(RANGE_LABELS) as RangeKey[]).map(key => `
      <button type="button" data-range="${key}" class="${key === selectedRange ? 'active' : ''}">
        ${RANGE_LABELS[key]}
      </button>
    `).join('');
    switchEl.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedRange = (btn as HTMLElement).dataset.range as RangeKey;
        renderWeek(container, snapshot);
      });
    });
  }

  const ranges: Partial<StoreSnapshot['usageRanges']> = snapshot.usageRanges ?? {
    last7Days: snapshot.last7Days,
  };
  const days = ranges[selectedRange] ?? snapshot.last7Days;
  // The 12-month range has one entry per month, keyed YYYY-MM.
  const monthly = selectedRange === 'last12Months';
  const unit = monthly ? 'mo' : 'day';
  const totals = days.map(d => bucketTotal(d.bucket.tokens));
  const maxTotal = Math.max(...totals, 1);
  const weekTotal = totals.reduce((sum, n) => sum + n, 0);
  const activeDays = totals.filter(n => n > 0).length;
  const peak = Math.max(...totals, 0);
  const peakIndex = totals.indexOf(peak);
  const dailyAvg = Math.round(weekTotal / Math.max(days.length, 1));
  const byModel = new Map<string, number>();

  for (const { bucket } of days) {
    for (const [model, bucketTokens] of Object.entries(bucket.byModel)) {
      byModel.set(model, (byModel.get(model) ?? 0) + bucketTotal(bucketTokens));
    }
  }

  // Stack segments in one order for the whole range, largest first, so a
  // model keeps its position from bar to bar.
  const rank = new Map([...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m], i) => [m, i]));

  if (summaryEl) {
    const peakDay = peakIndex >= 0 && peak > 0 ? shortDate(days[peakIndex]!.day) : 'none';
    summaryEl.innerHTML = `
      <div class="week-summary-main">${formatCompact(weekTotal)} tok</div>
      <div class="week-summary-grid">
        <span><b>${formatCompact(dailyAvg)}</b> avg/${unit}</span>
        <span><b>${formatCompact(peak)}</b> peak ${peakDay}</span>
        <span><b>${activeDays}</b>/${days.length} active</span>
      </div>
    `;
  }

  chartEl.innerHTML = '';
  chartEl.classList.toggle('compact', days.length > 14);

  for (let i = 0; i < days.length; i++) {
    const { day, bucket } = days[i]!;
    const total = totals[i]!;

    const group = document.createElement('div');
    group.className = 'week-bar-group';

    const stack = document.createElement('div');
    stack.className = 'week-bar-stack';

    const stackHeightPx = total === 0 ? 4 : Math.max(Math.round((total / maxTotal) * MAX_BAR_PX), 6);
    stack.style.height = `${stackHeightPx}px`;

    if (total > 0) {
      const models = Object.entries(bucket.byModel)
        .filter(([, b]) => bucketTotal(b) > 0)
        .sort((a, b) => (rank.get(a[0]) ?? 99) - (rank.get(b[0]) ?? 99));

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

    const value = document.createElement('div');
    value.className = 'week-value';
    value.textContent = total > 0 ? formatCompact(total) : '0';
    group.appendChild(value);

    const label = document.createElement('div');
    label.className = 'week-day';
    label.textContent = formatDayLabel(day, days.length);
    group.appendChild(label);

    chartEl.appendChild(group);
  }

  if (legendEl) {
    const legend = [...byModel.entries()]
      .filter(([, total]) => total > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    legendEl.innerHTML = legend.length === 0
      ? ''
      : legend.map(([model, total]) => `
          <span class="week-legend-item">
            <span class="model-dot" style="background:${modelColor(model)}"></span>
            ${escapeHtml(modelShort(model))} ${formatCompact(total)}
          </span>
        `).join('');
  }
}

/** Range entries are days (YYYY-MM-DD), or months (YYYY-MM) in the 12-month range. */
const isMonth = (key: string) => key.length === 7;
const toDate = (key: string) => new Date((isMonth(key) ? key + '-01' : key) + 'T12:00:00');

function shortDate(day: string): string {
  const d = toDate(day);
  if (isMonth(day)) return new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' }).format(d);
  return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
}

function formatDayLabel(day: string, count: number): string {
  const d = toDate(day);
  if (isMonth(day)) return new Intl.DateTimeFormat(undefined, { month: 'narrow' }).format(d);
  if (count <= 7) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d).slice(0, 2);
  }
  return new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(d);
}
