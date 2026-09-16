// Category budget allocation (rv2.1).
//
// Steady category budgets are a constant per-canonical-window baseline —
// never a monthly amount divided by however many paydays a calendar month
// happens to contain. There is deliberately no "divide by paydays in
// month" function anywhere in this file.

import { assignDateToCanonicalWindow } from "./payWindow";
import type {
  CanonicalWindow,
  CategoryWindowBudget,
  PaySchedule,
  Transaction,
} from "./types";

/**
 * The per-window amount in effect for a category at a given window's
 * start: the most recent `effectiveFrom` on or before `windowStart`. A
 * budget change takes effect starting with the window it was made in (or
 * later), and never gets retroactively re-divided.
 */
export function getCurrentWindowBudget(
  categoryWindowBudgets: CategoryWindowBudget[],
  categoryId: string,
  windowStart: string
): number | undefined {
  const applicable = categoryWindowBudgets
    .filter((b) => b.categoryId === categoryId && b.effectiveFrom <= windowStart)
    .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));

  return applicable[0]?.amount;
}

/**
 * Transactions for `categoryId` whose canonical-window assignment
 * (derived from posted_date, not calendar month) matches `window`.
 * Transfers are excluded — they aren't spending.
 */
export function filterTransactionsForCategoryWindow(
  transactions: Transaction[],
  categoryId: string,
  window: CanonicalWindow,
  canonicalPaySchedule: PaySchedule
): Transaction[] {
  return transactions.filter((t) => {
    if (t.isTransfer || t.categoryId !== categoryId) return false;
    const assigned = assignDateToCanonicalWindow(t.postedDate, canonicalPaySchedule);
    return assigned.start === window.start && assigned.end === window.end;
  });
}

/**
 * Remaining balance for a category in a single window: the window's flat
 * budget minus whatever has been spent against it in that same window.
 * Membership is by canonical-window assignment, not calendar month, so a
 * window that spans a month boundary keeps one whole, uninterrupted
 * balance for its full 14 days.
 */
export function computeCategoryBalanceForWindow(
  windowBudgetAmount: number,
  transactionsInWindow: Transaction[]
): number {
  const spent = transactionsInWindow.reduce((sum, t) => sum + t.amount, 0);
  return windowBudgetAmount - spent;
}
