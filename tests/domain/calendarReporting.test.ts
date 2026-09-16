import { describe, expect, it } from "vitest";
import { prorateWindowAcrossMonths } from "@/lib/domain/calendarReporting";
import { computeCategoryBalanceForWindow } from "@/lib/domain/categoryAllocation";

describe("prorateWindowAcrossMonths", () => {
  it("splits a cross-month window by day-count, matching the brief's own Aug 28 - Sep 10 example", () => {
    // 14-day window: Aug 28-31 (4 days) + Sep 1-10 (10 days).
    const window = { start: "2026-08-28", end: "2026-09-11" };
    const attributions = prorateWindowAcrossMonths(window, 150);

    expect(attributions).toEqual([
      { year: 2026, month: 8, days: 4, amount: 42.86 },
      { year: 2026, month: 9, days: 10, amount: 107.14 },
    ]);
  });

  it("sums exactly to the original amount despite rounding", () => {
    const window = { start: "2026-08-28", end: "2026-09-11" };
    const attributions = prorateWindowAcrossMonths(window, 150);
    const total = attributions.reduce((sum, a) => sum + a.amount, 0);
    expect(Math.round(total * 100) / 100).toBe(150);
  });

  it("returns a single full segment for a window that doesn't cross a month boundary", () => {
    const window = { start: "2026-01-02", end: "2026-01-16" };
    expect(prorateWindowAcrossMonths(window, 150)).toEqual([
      { year: 2026, month: 1, days: 14, amount: 150 },
    ]);
  });

  it("never changes the operational window balance — reporting proration is a read-only view", () => {
    const window = { start: "2026-08-28", end: "2026-09-11" };
    const windowBudgetAmount = 150;

    // Whether or not anyone ever calls the reporting proration, the
    // operational balance for the window is the same: the full $150 minus
    // whatever was actually spent in that window.
    const balanceBeforeReporting = computeCategoryBalanceForWindow(windowBudgetAmount, [
      {
        id: "t1",
        accountId: "acct-1",
        postedDate: "2026-09-03",
        pending: false,
        amount: 20,
        description: "Groceries",
        categoryId: "cat-groceries",
        isTransfer: false,
      },
    ]);

    prorateWindowAcrossMonths(window, windowBudgetAmount); // exercised, result discarded

    const balanceAfterReporting = computeCategoryBalanceForWindow(windowBudgetAmount, [
      {
        id: "t1",
        accountId: "acct-1",
        postedDate: "2026-09-03",
        pending: false,
        amount: 20,
        description: "Groceries",
        categoryId: "cat-groceries",
        isTransfer: false,
      },
    ]);

    expect(balanceAfterReporting).toBe(balanceBeforeReporting);
    expect(balanceAfterReporting).toBe(130);
  });
});
