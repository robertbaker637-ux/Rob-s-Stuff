// Paycheck projection + reconciliation (rv2.2).
//
// A regular income source's own pay_schedule can forecast its future
// paycheck events without anyone entering them one by one. Irregular
// (gig) income has no schedule and never gets a forecast — only actual
// deposits, once they happen.
//
// Reconciliation never destroys the forecast: reconcilePaycheck() adds
// the actual* fields onto the same record rather than overwriting
// projected*, so the original expectation stays available for
// variance/history even after Actual becomes authoritative for the
// financial math.

import { addDays, daysBetween, formatIsoDate, lastDayOfMonth, parseIsoDate } from "./dateUtil";
import type { IncomeSource, IsoDate, Paycheck, PaySchedule } from "./types";

/** The date this paycheck event should be matched against a canonical
 * window with: the actual date once reconciled, else the projected one.
 * Returns undefined for a malformed record with neither. */
export function getEffectivePayDate(paycheck: Paycheck): IsoDate | undefined {
  return paycheck.isActual ? paycheck.actualPayDate : paycheck.projectedPayDate;
}

/** The amount this paycheck event contributes to income-for-window: the
 * actual amount once reconciled, else the projected one. */
export function getEffectiveAmount(paycheck: Paycheck): number {
  const amount = paycheck.isActual ? paycheck.actualAmount : paycheck.projectedAmount;
  return amount ?? 0;
}

/**
 * Every real pay date `paySchedule` produces in `[fromDate, throughDate]`
 * (inclusive both ends). Deliberately separate from payWindow.ts's
 * canonical-window computation: that function refuses semimonthly by
 * design (semimonthly can never be the canonical schedule), but a
 * non-canonical regular income source (e.g. Church) is allowed to be
 * semimonthly, so payday generation has to support all three cadences.
 */
function generatePayDates(
  paySchedule: PaySchedule,
  fromDate: IsoDate,
  throughDate: IsoDate
): IsoDate[] {
  if (paySchedule.cadence === "semimonthly") {
    return generateSemimonthlyPayDates(paySchedule, fromDate, throughDate);
  }

  if (!paySchedule.anchorDate) {
    throw new Error("weekly/biweekly pay_schedule is missing an anchor_date.");
  }
  const intervalDays = paySchedule.cadence === "weekly" ? 7 : 14;
  const anchor = parseIsoDate(paySchedule.anchorDate);
  const from = parseIsoDate(fromDate);
  const through = parseIsoDate(throughDate);

  const diffDays = daysBetween(anchor, from);
  let cursor = addDays(anchor, Math.floor(diffDays / intervalDays) * intervalDays);
  while (cursor.getTime() < from.getTime()) cursor = addDays(cursor, intervalDays);

  const dates: IsoDate[] = [];
  while (cursor.getTime() <= through.getTime()) {
    dates.push(formatIsoDate(cursor));
    cursor = addDays(cursor, intervalDays);
  }
  return dates;
}

function generateSemimonthlyPayDates(
  paySchedule: PaySchedule,
  fromDate: IsoDate,
  throughDate: IsoDate
): IsoDate[] {
  const dayA = paySchedule.semimonthlyDayA;
  const dayB = paySchedule.semimonthlyDayB;
  if (dayA === undefined || dayB === undefined) {
    throw new Error("semimonthly pay_schedule is missing its day-of-month pair.");
  }

  const from = parseIsoDate(fromDate);
  const through = parseIsoDate(throughDate);
  const dates: IsoDate[] = [];

  let year = from.getUTCFullYear();
  let month = from.getUTCMonth() + 1; // 1-12

  const resolveDay = (day: number, y: number, m: number) => (day === 0 ? lastDayOfMonth(y, m) : day);

  while (true) {
    const candidateYearMonth = year * 100 + month;
    const throughYearMonth = through.getUTCFullYear() * 100 + (through.getUTCMonth() + 1);
    if (candidateYearMonth > throughYearMonth) break;

    for (const day of [dayA, dayB]) {
      const resolvedDay = resolveDay(day, year, month);
      const candidate = new Date(Date.UTC(year, month - 1, resolvedDay));
      if (candidate.getTime() >= from.getTime() && candidate.getTime() <= through.getTime()) {
        dates.push(formatIsoDate(candidate));
      }
    }

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return dates.sort();
}

/**
 * Forecasts future paycheck events for a regular income source from its
 * own pay_schedule + expected_per_paycheck baseline. Returns [] for an
 * irregular source — gig income has no cadence to project from, per the
 * brief. Returns [] if expected_per_paycheck isn't set (nothing to
 * project an amount from).
 */
export function projectExpectedPaychecks(
  incomeSource: IncomeSource,
  paySchedule: PaySchedule,
  fromDate: IsoDate,
  throughDate: IsoDate
): Paycheck[] {
  if (incomeSource.type === "irregular") return [];
  if (incomeSource.expectedPerPaycheck === undefined) return [];

  return generatePayDates(paySchedule, fromDate, throughDate).map((payDate) => ({
    id: `${incomeSource.id}-proj-${payDate}`,
    incomeSourceId: incomeSource.id,
    projectedPayDate: payDate,
    projectedAmount: incomeSource.expectedPerPaycheck,
    autoSplitAmount: 0,
    isActual: false,
  }));
}

/**
 * Matches a real deposit to a projected paycheck event. Returns a NEW
 * record with the actual* fields populated and isActual flipped to true
 * — projectedPayDate/projectedAmount are left untouched, so the original
 * forecast survives for variance/history. Canonical-window assignment
 * downstream always reads the actual side once isActual is true (see
 * getEffectivePayDate), so the projected contribution stops counting in
 * its old window the moment this returns — it never counts in both.
 */
export function reconcilePaycheck(
  paycheck: Paycheck,
  actualPayDate: IsoDate,
  actualAmount: number,
  actualGross?: number
): Paycheck {
  return {
    ...paycheck,
    actualPayDate,
    actualAmount,
    actualGross,
    isActual: true,
  };
}
