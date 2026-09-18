import { describe, expect, it } from "vitest";
import {
  computeSplitAwareCategoryBalanceForWindow,
  getEffectiveCategoryLineItems,
  validateSplitAllocations,
} from "@/lib/domain/transactionSplits";
import {
  computeCategoryBalanceForWindow,
  filterTransactionsForCategoryWindow,
} from "@/lib/domain/categoryAllocation";
import type { PaySchedule, Transaction, TransactionSplit } from "@/lib/domain/types";

const ckSchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

const window = { start: "2026-01-02", end: "2026-01-16" };

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    accountId: "acct-checking",
    postedDate: "2026-01-06",
    pending: false,
    amount: 90,
    description: "Target",
    isTransfer: false,
    rawDescription: "Target",
    rawAmount: 90,
    rawDate: "2026-01-06",
    needsReview: false,
    ...overrides,
  };
}

describe("validateSplitAllocations", () => {
  it("passes when splits sum exactly to the parent amount", () => {
    const txn = makeTransaction({ id: "t-target", amount: 90 });
    const splits: TransactionSplit[] = [
      { id: "s1", transactionId: "t-target", categoryId: "cat-groceries", amount: 50 },
      { id: "s2", transactionId: "t-target", categoryId: "cat-household", amount: 40 },
    ];
    expect(validateSplitAllocations(txn, splits)).toBe(true);
  });

  it("fails when splits do not sum to the parent amount", () => {
    const txn = makeTransaction({ id: "t-target", amount: 90 });
    const splits: TransactionSplit[] = [
      { id: "s1", transactionId: "t-target", categoryId: "cat-groceries", amount: 50 },
      { id: "s2", transactionId: "t-target", categoryId: "cat-household", amount: 30 },
    ];
    expect(validateSplitAllocations(txn, splits)).toBe(false);
  });

  it("is cent-safe against floating point drift", () => {
    const txn = makeTransaction({ id: "t-x", amount: 10.0 });
    const splits: TransactionSplit[] = [
      { id: "s1", transactionId: "t-x", categoryId: "cat-a", amount: 3.33 },
      { id: "s2", transactionId: "t-x", categoryId: "cat-b", amount: 3.33 },
      { id: "s3", transactionId: "t-x", categoryId: "cat-c", amount: 3.34 },
    ];
    expect(validateSplitAllocations(txn, splits)).toBe(true);
  });
});

describe("getEffectiveCategoryLineItems", () => {
  it("returns the splits when the transaction has any", () => {
    const txn = makeTransaction({ id: "t-target", amount: 90, categoryId: "cat-groceries" });
    const splits: TransactionSplit[] = [
      { id: "s1", transactionId: "t-target", categoryId: "cat-groceries", amount: 50 },
      { id: "s2", transactionId: "t-target", categoryId: "cat-household", amount: 40 },
    ];
    expect(getEffectiveCategoryLineItems(txn, splits)).toEqual([
      { categoryId: "cat-groceries", amount: 50 },
      { categoryId: "cat-household", amount: 40 },
    ]);
  });

  it("falls back to a single line item from the transaction's own category/amount when there are no splits", () => {
    const txn = makeTransaction({ id: "t-plain", amount: 45, categoryId: "cat-groceries" });
    expect(getEffectiveCategoryLineItems(txn, [])).toEqual([
      { categoryId: "cat-groceries", amount: 45 },
    ]);
  });
});

describe("computeSplitAwareCategoryBalanceForWindow", () => {
  it("only deducts a split transaction's own portion from each category", () => {
    const splitTxn = makeTransaction({ id: "t-target", amount: 90, postedDate: "2026-01-06" });
    const plainTxn = makeTransaction({
      id: "t-plain",
      amount: 20,
      postedDate: "2026-01-08",
      categoryId: "cat-groceries",
    });
    const splits: TransactionSplit[] = [
      { id: "s1", transactionId: "t-target", categoryId: "cat-groceries", amount: 50 },
      { id: "s2", transactionId: "t-target", categoryId: "cat-household", amount: 40 },
    ];

    const groceriesBalance = computeSplitAwareCategoryBalanceForWindow(
      "cat-groceries",
      150,
      [splitTxn, plainTxn],
      splits,
      window,
      ckSchedule
    );
    const householdBalance = computeSplitAwareCategoryBalanceForWindow(
      "cat-household",
      60,
      [splitTxn, plainTxn],
      splits,
      window,
      ckSchedule
    );

    expect(groceriesBalance).toBe(150 - 50 - 20); // 80 — split share + the plain txn
    expect(householdBalance).toBe(60 - 40); // 20 — only the split share
  });

  it("matches the existing single-category math exactly for a transaction with no splits", () => {
    const plainTxn = makeTransaction({ id: "t-plain", amount: 45, categoryId: "cat-groceries" });

    const splitAware = computeSplitAwareCategoryBalanceForWindow(
      "cat-groceries",
      150,
      [plainTxn],
      [],
      window,
      ckSchedule
    );

    const inWindow = filterTransactionsForCategoryWindow([plainTxn], "cat-groceries", window, ckSchedule);
    const existing = computeCategoryBalanceForWindow(150, inWindow);

    expect(splitAware).toBe(existing);
    expect(splitAware).toBe(105);
  });

  it("excludes transfers, split-aware, just like the non-split path", () => {
    const transferTxn = makeTransaction({
      id: "t-transfer",
      amount: 500,
      categoryId: "cat-groceries",
      isTransfer: true,
    });
    const balance = computeSplitAwareCategoryBalanceForWindow(
      "cat-groceries",
      150,
      [transferTxn],
      [],
      window,
      ckSchedule
    );
    expect(balance).toBe(150);
  });
});
