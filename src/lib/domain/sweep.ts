// Sweep formula (rv2.1, income aggregation updated in rv2.2 for the
// projected/actual paycheck split — see paycheck.ts).
//
// sweep = total income assigned to the canonical window
//         − bills due in that window
//         − steady category allocations for that window
//
// Income is not CK-only: any income that actually lands during a
// canonical window contributes to that window's total, whether or not it
// came from the income source that defines the window's boundaries.

import { getEffectiveAmount, getEffectivePayDate } from "./paycheck";
import { assignDateToCanonicalWindow } from "./payWindow";
import type {
  Bill,
  CanonicalWindow,
  CategoryWindowBudget,
  IncomeSource,
  Paycheck,
  PaySchedule,
} from "./types";

/**
 * Sums every paycheck/deposit assigned into `window` across all income
 * sources, using each record's effective (actual-if-reconciled, else
 * projected) date and amount:
 *  - Regular sources (Circle K, Church): Actual once reconciled, else
 *    that source's own projected amount while still a forecast.
 *  - Irregular sources (gig): only reconciled (actual) deposits count.
 *    This is enforced defensively here, independent of whether a
 *    projected* field happens to be set on the record — irregular income
 *    must never contribute a forecast amount, since it has no schedule
 *    to have projected one from in the first place.
 */
export function computeIncomeForWindow(
  window: CanonicalWindow,
  canonicalPaySchedule: PaySchedule,
  incomeSources: IncomeSource[],
  paychecks: Paycheck[]
): number {
  const sourceById = new Map(incomeSources.map((s) => [s.id, s]));

  return paychecks.reduce((sum, paycheck) => {
    const source = sourceById.get(paycheck.incomeSourceId);
    if (!source) return sum;

    if (source.type === "irregular") {
      if (!paycheck.isActual || !paycheck.actualPayDate) return sum;
      const assigned = assignDateToCanonicalWindow(paycheck.actualPayDate, canonicalPaySchedule);
      if (assigned.start !== window.start || assigned.end !== window.end) return sum;
      return sum + (paycheck.actualAmount ?? 0);
    }

    const payDate = getEffectivePayDate(paycheck);
    if (!payDate) return sum;
    const assigned = assignDateToCanonicalWindow(payDate, canonicalPaySchedule);
    if (assigned.start !== window.start || assigned.end !== window.end) return sum;
    return sum + getEffectiveAmount(paycheck);
  }, 0);
}

/** Bills whose due_date falls in `window`, matched against the canonical
 * schedule only — never any other income source's timing. */
export function getBillsInWindow(
  bills: Bill[],
  window: CanonicalWindow,
  canonicalPaySchedule: PaySchedule
): Bill[] {
  return bills.filter((b) => {
    const assigned = assignDateToCanonicalWindow(b.dueDate, canonicalPaySchedule);
    return assigned.start === window.start && assigned.end === window.end;
  });
}

export function computeSweepAmount(
  incomeForWindow: number,
  billsInWindow: Bill[],
  categoryWindowBudgetsForWindow: CategoryWindowBudget[]
): number {
  const billTotal = billsInWindow.reduce((sum, b) => sum + b.amount, 0);
  const categoryTotal = categoryWindowBudgetsForWindow.reduce((sum, c) => sum + c.amount, 0);
  return incomeForWindow - billTotal - categoryTotal;
}
