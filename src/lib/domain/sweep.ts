// Sweep formula (rv2.1).
//
// sweep = total income assigned to the canonical window
//         − bills due in that window
//         − steady category allocations for that window
//
// Income is not CK-only: any income that actually lands during a
// canonical window contributes to that window's total, whether or not it
// came from the income source that defines the window's boundaries.

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
 * Every paycheck (from any income source) whose pay_date falls in
 * `window`. Church's own paydays land here alongside Circle K's, and gig
 * deposits land here too, all bucketed purely by date against the
 * canonical schedule.
 */
function paychecksInWindow(
  window: CanonicalWindow,
  canonicalPaySchedule: PaySchedule,
  paychecks: Paycheck[]
): Paycheck[] {
  return paychecks.filter((p) => {
    const assigned = assignDateToCanonicalWindow(p.payDate, canonicalPaySchedule);
    return assigned.start === window.start && assigned.end === window.end;
  });
}

/**
 * Sums every paycheck/deposit assigned into `window` across all income
 * sources:
 *  - Regular sources (Circle K, Church): Actual net once known, else
 *    that source's own expected_per_paycheck while still projected.
 *  - Irregular sources (gig): only actual deposits count; there is no
 *    expected contribution, since irregular income has no schedule to
 *    project one from.
 */
export function computeIncomeForWindow(
  window: CanonicalWindow,
  canonicalPaySchedule: PaySchedule,
  incomeSources: IncomeSource[],
  paychecks: Paycheck[]
): number {
  const sourceById = new Map(incomeSources.map((s) => [s.id, s]));
  const inWindow = paychecksInWindow(window, canonicalPaySchedule, paychecks);

  return inWindow.reduce((sum, paycheck) => {
    const source = sourceById.get(paycheck.incomeSourceId);
    if (!source) return sum;

    if (source.type === "irregular") {
      return paycheck.isActual ? sum + paycheck.net : sum;
    }

    // Regular source: Actual once known, else its own expected baseline.
    const amount = paycheck.isActual ? paycheck.net : paycheck.expectedPerPaycheck ?? 0;
    return sum + amount;
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
