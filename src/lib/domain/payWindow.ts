// Canonical operating window math (rv2.1).
//
// There is exactly one canonical window structure per household, defined
// solely by the primary income source's pay_schedule (weekly or biweekly
// — never semimonthly). Window N = [payday_N, payday_(N+1)), inclusive
// start, exclusive end. A window is a true fixed-length operating period
// that is never reset or split at a calendar-month boundary: Sep 1 does
// not begin a new window just because the month changed.

import type { CanonicalWindow, IsoDate, PaySchedule } from "./types";
import { addDays, daysBetween, formatIsoDate, parseIsoDate } from "./dateUtil";

function intervalDaysFor(cadence: PaySchedule["cadence"]): number {
  if (cadence === "weekly") return 7;
  if (cadence === "biweekly") return 14;
  throw new Error(
    `computeCanonicalWindow only supports weekly/biweekly schedules; ` +
      `semimonthly cannot be the canonical window source (got "${cadence}").`
  );
}

/**
 * The single canonical window containing `targetDate`, computed from the
 * primary income source's schedule via exact interval arithmetic off its
 * anchor_date. Always call this with the household's designated canonical
 * pay_schedule — never a non-primary income source's schedule.
 */
export function computeCanonicalWindow(
  canonicalPaySchedule: PaySchedule,
  targetDate: IsoDate
): CanonicalWindow {
  if (!canonicalPaySchedule.anchorDate) {
    throw new Error("Canonical pay_schedule is missing an anchor_date.");
  }
  const intervalDays = intervalDaysFor(canonicalPaySchedule.cadence);
  const anchor = parseIsoDate(canonicalPaySchedule.anchorDate);
  const target = parseIsoDate(targetDate);

  const diffDays = daysBetween(anchor, target);
  const windowIndex = Math.floor(diffDays / intervalDays);

  const start = addDays(anchor, windowIndex * intervalDays);
  const end = addDays(start, intervalDays);

  return { start: formatIsoDate(start), end: formatIsoDate(end) };
}

/**
 * Buckets an arbitrary date (a non-primary income source's actual or
 * projected payday, a bill's due date, a transaction's posted date) into
 * the single canonical window that contains it. This is the mechanism
 * that lets other income sources and transactions participate in the
 * household's one window structure without owning windows of their own.
 */
export function assignDateToCanonicalWindow(
  date: IsoDate,
  canonicalPaySchedule: PaySchedule
): CanonicalWindow {
  return computeCanonicalWindow(canonicalPaySchedule, date);
}

/**
 * All canonical windows that overlap the given calendar month (1-12).
 * Because windows tile the timeline with no gaps, this walks forward from
 * the window containing the 1st of the month until a window starts after
 * the last day of the month. Used for calendar reporting and the
 * Dashboard's "next payday" card — never as a division denominator for
 * category budgets.
 */
export function getWindowsOverlappingMonth(
  canonicalPaySchedule: PaySchedule,
  year: number,
  month: number
): CanonicalWindow[] {
  const monthStart = formatIsoDate(new Date(Date.UTC(year, month - 1, 1)));
  const monthEndExclusive = formatIsoDate(new Date(Date.UTC(year, month, 1)));

  const windows: CanonicalWindow[] = [];
  let window = computeCanonicalWindow(canonicalPaySchedule, monthStart);

  while (window.start < monthEndExclusive) {
    windows.push(window);
    window = computeCanonicalWindow(canonicalPaySchedule, window.end);
  }

  return windows;
}
