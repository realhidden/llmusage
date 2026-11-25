/**
 * Local-TZ calendar day as YYYY-MM-DD, or '' for an unparseable timestamp.
 *
 * Runs once per ingested event, so no Intl here: constructing a DateTimeFormat
 * per call was most of a cold scan's CPU time.
 */
export function dayKey(isoTs: string): string {
  const d = new Date(isoTs);
  if (Number.isNaN(d.getTime())) return '';
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${m < 10 ? '0' : ''}${m}-${day < 10 ? '0' : ''}${day}`;
}

export function todayKey(): string {
  return dayKey(new Date().toISOString());
}

export function formatCompact(n: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function last7Days(): string[] {
  return lastNDays(7);
}

export function lastNDays(count: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(dayKey(d.toISOString()));
  }
  return days;
}

export function monthDays(monthOffset: number): string[] {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1, 12);
  const last = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0, 12);
  const days: string[] = [];
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    days.push(dayKey(d.toISOString()));
  }
  return days;
}

/** The last `count` calendar months as YYYY-MM, oldest first, ending with this one. */
export function lastNMonths(count: number): string[] {
  const now = new Date();
  const months: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1, 12);
    const m = d.getMonth() + 1;
    months.push(`${d.getFullYear()}-${m < 10 ? '0' : ''}${m}`);
  }
  return months;
}
