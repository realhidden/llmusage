export function dayKey(isoTs: string): string {
  const d = new Date(isoTs);
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(d);
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
