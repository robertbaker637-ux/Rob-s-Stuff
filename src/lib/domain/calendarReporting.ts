// Calendar reporting proration (rv2.1).
//
// Calendar month/quarter/year are reporting-only views, never the
// operational source of truth. When a canonical window spans two calendar
// months, its budget can be prorated by day-count for reporting purposes
// — but that proration never changes the actual operational balance
// available in the window, which is computed entirely in
// categoryAllocation.ts against the window as one whole 14-day bucket.

import type { CanonicalWindow } from "./types";
import { addDays, parseIsoDate } from "./dateUtil";

export interface MonthAttribution {
  year: number;
  month: number; // 1-12
  days: number;
  amount: number;
}

/**
 * Splits `amount` across the calendar month(s) a window spans, weighted by
 * how many of the window's days fall in each month. The last segment
 * absorbs any rounding remainder so the parts always sum exactly to
 * `amount` — reporting must never invent or lose money to rounding.
 *
 * This is a pure display/reporting helper. It does not read or write
 * anything from categoryAllocation.ts and has no effect on operational
 * window balances.
 */
export function prorateWindowAcrossMonths(
  window: CanonicalWindow,
  amount: number
): MonthAttribution[] {
  const start = parseIsoDate(window.start);
  const end = parseIsoDate(window.end); // exclusive

  const dayCountsByMonth = new Map<string, { year: number; month: number; days: number }>();
  let totalDays = 0;
  for (let cursor = start; cursor.getTime() < end.getTime(); cursor = addDays(cursor, 1)) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const key = `${year}-${month}`;
    const existing = dayCountsByMonth.get(key);
    if (existing) {
      existing.days += 1;
    } else {
      dayCountsByMonth.set(key, { year, month, days: 1 });
    }
    totalDays += 1;
  }

  const segments = [...dayCountsByMonth.values()];
  const attributions: MonthAttribution[] = [];
  let allocated = 0;

  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    const rawAmount = (amount * segment.days) / totalDays;
    const roundedAmount = isLast
      ? Math.round((amount - allocated) * 100) / 100
      : Math.round(rawAmount * 100) / 100;
    allocated += roundedAmount;
    attributions.push({
      year: segment.year,
      month: segment.month,
      days: segment.days,
      amount: roundedAmount,
    });
  });

  return attributions;
}
