// Split transactions (rv2.3, Step 4).
//
// This module is ADDITIVE: categoryAllocation.ts's existing
// computeCategoryBalanceForWindow/filterTransactionsForCategoryWindow are
// untouched and keep passing their current tests verbatim. A non-split
// transaction produces the exact same effective line item those
// functions already assume (its own categoryId + full amount), so
// computeSplitAwareCategoryBalanceForWindow here is a strict
// generalization, not a behavior change, for the common single-category
// case.

import { assignDateToCanonicalWindow } from "./payWindow";
import type { CanonicalWindow, PaySchedule, Transaction, TransactionSplit } from "./types";

/** A transaction's splits must sum exactly to its own amount — cent-safe
 * via rounding, same pattern as calendarReporting.ts's remainder
 * handling. */
export function validateSplitAllocations(
  transaction: Transaction,
  splits: TransactionSplit[]
): boolean {
  const total = splits.reduce((sum, s) => sum + s.amount, 0);
  return Math.round(total * 100) === Math.round(transaction.amount * 100);
}

/**
 * The category/amount pairs a transaction effectively contributes: its
 * splits if it has any, else a single line item from its own
 * categoryId/amount. This is what makes a non-split transaction behave
 * identically to today's single-category model.
 */
export function getEffectiveCategoryLineItems(
  transaction: Transaction,
  splits: TransactionSplit[]
): Array<{ categoryId: string; amount: number }> {
  const ownSplits = splits.filter((s) => s.transactionId === transaction.id);
  if (ownSplits.length > 0) {
    return ownSplits.map((s) => ({ categoryId: s.categoryId, amount: s.amount }));
  }
  if (!transaction.categoryId) return [];
  return [{ categoryId: transaction.categoryId, amount: transaction.amount }];
}

function filterNonTransferTransactionsInWindow(
  transactions: Transaction[],
  window: CanonicalWindow,
  canonicalPaySchedule: PaySchedule
): Transaction[] {
  return transactions.filter((t) => {
    if (t.isTransfer) return false;
    const assigned = assignDateToCanonicalWindow(t.postedDate, canonicalPaySchedule);
    return assigned.start === window.start && assigned.end === window.end;
  });
}

/**
 * Split-aware remaining balance for a category in a window: the window's
 * flat budget minus every transaction's effective contribution to that
 * category — a split transaction only contributes the portion allocated
 * to `categoryId`, not its full amount.
 */
export function computeSplitAwareCategoryBalanceForWindow(
  categoryId: string,
  windowBudgetAmount: number,
  transactions: Transaction[],
  splits: TransactionSplit[],
  window: CanonicalWindow,
  canonicalPaySchedule: PaySchedule
): number {
  const inWindow = filterNonTransferTransactionsInWindow(transactions, window, canonicalPaySchedule);
  const spent = inWindow.reduce((sum, t) => {
    const lineItems = getEffectiveCategoryLineItems(t, splits);
    const contribution = lineItems
      .filter((li) => li.categoryId === categoryId)
      .reduce((s, li) => s + li.amount, 0);
    return sum + contribution;
  }, 0);
  return windowBudgetAmount - spent;
}
