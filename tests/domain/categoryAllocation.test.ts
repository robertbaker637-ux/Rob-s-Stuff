import { describe, expect, it } from "vitest";
import {
  computeCategoryBalanceForWindow,
  filterTransactionsForCategoryWindow,
  getCurrentWindowBudget,
} from "@/lib/domain/categoryAllocation";
import type { CategoryWindowBudget, PaySchedule, Transaction } from "@/lib/domain/types";

const ckSchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

const groceriesBudgets: CategoryWindowBudget[] = [
  { id: "b1", categoryId: "cat-groceries", amount: 150, effectiveFrom: "2025-01-01" },
];

describe("getCurrentWindowBudget", () => {
  it("is identical across a 3-payday calendar month (January) and a 2-payday calendar month (April) — never divided by paydays-in-month", () => {
    // January 2026 windows (Jan 2, Jan 16, Jan 30 paydays -> 3-payday month)
    for (const windowStart of ["2026-01-02", "2026-01-16", "2026-01-30"]) {
      expect(getCurrentWindowBudget(groceriesBudgets, "cat-groceries", windowStart)).toBe(150);
    }
    // April 2026 windows (Apr 10, Apr 24 paydays -> 2-payday month)
    for (const windowStart of ["2026-04-10", "2026-04-24"]) {
      expect(getCurrentWindowBudget(groceriesBudgets, "cat-groceries", windowStart)).toBe(150);
    }
  });

  it("picks up a rate change only from its effective_from window onward, never retroactively re-dividing prior windows", () => {
    const budgetsWithChange: CategoryWindowBudget[] = [
      { id: "b1", categoryId: "cat-groceries", amount: 150, effectiveFrom: "2025-01-01" },
      { id: "b2", categoryId: "cat-groceries", amount: 175, effectiveFrom: "2026-01-16" },
    ];
    expect(getCurrentWindowBudget(budgetsWithChange, "cat-groceries", "2026-01-02")).toBe(150);
    expect(getCurrentWindowBudget(budgetsWithChange, "cat-groceries", "2026-01-16")).toBe(175);
    expect(getCurrentWindowBudget(budgetsWithChange, "cat-groceries", "2026-01-30")).toBe(175);
  });
});

describe("filterTransactionsForCategoryWindow + computeCategoryBalanceForWindow", () => {
  it("keeps a window's balance whole across a month boundary — a Feb-dated transaction still counts against the Jan 30 window", () => {
    const window = { start: "2026-01-30", end: "2026-02-13" };
    const transactions: Transaction[] = [
      {
        id: "t1",
        accountId: "acct-1",
        postedDate: "2026-01-31",
        pending: false,
        amount: 20,
        description: "Grocery run before month end",
        categoryId: "cat-groceries",
        isTransfer: false,
      },
      {
        id: "t2",
        accountId: "acct-1",
        postedDate: "2026-02-03",
        pending: false,
        amount: 30,
        description: "Grocery run after month started",
        categoryId: "cat-groceries",
        isTransfer: false,
      },
      {
        id: "t3",
        accountId: "acct-1",
        postedDate: "2026-02-20",
        pending: false,
        amount: 999,
        description: "Belongs to the next window entirely — must not leak in",
        categoryId: "cat-groceries",
        isTransfer: false,
      },
    ];

    const inWindow = filterTransactionsForCategoryWindow(
      transactions,
      "cat-groceries",
      window,
      ckSchedule
    );
    expect(inWindow.map((t) => t.id)).toEqual(["t1", "t2"]);

    const budget = getCurrentWindowBudget(groceriesBudgets, "cat-groceries", window.start)!;
    expect(computeCategoryBalanceForWindow(budget, inWindow)).toBe(100); // 150 - 20 - 30
  });

  it("excludes transfers from a category's window balance", () => {
    const window = { start: "2026-01-02", end: "2026-01-16" };
    const transactions: Transaction[] = [
      {
        id: "t1",
        accountId: "acct-1",
        postedDate: "2026-01-05",
        pending: false,
        amount: 500,
        description: "Checking -> Savings",
        categoryId: "cat-groceries",
        isTransfer: true,
      },
    ];
    const inWindow = filterTransactionsForCategoryWindow(
      transactions,
      "cat-groceries",
      window,
      ckSchedule
    );
    expect(inWindow).toHaveLength(0);
  });
});
