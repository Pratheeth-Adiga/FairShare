// parse the local calendar day directly so timezone offsets don't shift it
function parseCalendarDay(dateStr: string): { year: number; month: number; day: number } | null {
  const iso = (dateStr || '').split('T')[0] ?? '';
  const parts = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(iso);
  if (!parts) return null;
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Returns a Date at local midnight for the calendar day named by `dateStr`. */
export function toLocalDate(dateStr: string): Date {
  const parsed = parseCalendarDay(dateStr);
  // An unparseable value yields an Invalid Date, which renders as "Invalid Date".
  // That is honest, and far better than silently inventing a plausible-looking
  // day the user never entered.
  if (!parsed) return new Date(NaN);
  return new Date(parsed.year, parsed.month - 1, parsed.day);
}

/** Format a calendar day in the Indian DD/MM/YYYY convention. */
export function formatExpenseDate(dateStr: string, options?: Intl.DateTimeFormatOptions): string {
  return toLocalDate(dateStr).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    ...options,
  });
}

/** Today's calendar day in the viewer's local timezone as `YYYY-MM-DD`. */
export function todayLocalYMD(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
