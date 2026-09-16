import { describe, expect, it } from "vitest";
import { computeIncomeForWindow, computeSweepAmount, getBillsInWindow } from "@/lib/domain/sweep";
import type { Bill, CategoryWindowBudget, IncomeSource, Paycheck, PaySchedule } from "@/lib/domain/types";

const ckSchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

const window = { start: "2026-01-02", end: "2026-01-16" };

const ck: IncomeSource = { id: "src-ck", name: "Circle K", type: "regular", isPrimaryWindowSource: true };
const church: IncomeSource = { id: "src-church", name: "Church", type: "regular", isPrimaryWindowSource: false };
const gig: IncomeSource = { id: "src-gig", name: "Gig", type: "irregular", isPrimaryWindowSource: false };

const categoryBudgets: CategoryWindowBudget[] = [
  { id: "b-groceries", categoryId: "cat-groceries", amount: 150, effectiveFrom: "2025-01-01" },
  { id: "b-utilities", categoryId: "cat-utilities", amount: 50, effectiveFrom: "2025-01-01" },
];

const ckActualPaycheck: Paycheck = {
  id: "pc-ck-1",
  incomeSourceId: "src-ck",
  payDate: "2026-01-02",
  autoSplitAmount: 0,
  net: 1650,
  isActual: true,
};

describe("computeSweepAmount", () => {
  it("moves with bills while the category allocation stays constant", () => {
    const heavyBills: Bill[] = [
      { id: "bill-rent", name: "Rent", amount: 700, dueDate: "2026-01-05", paidStatus: false, type: "bill" },
      { id: "bill-internet", name: "Internet", amount: 60, dueDate: "2026-01-12", paidStatus: false, type: "bill" },
    ];
    const lightBills: Bill[] = [];

    const income = computeIncomeForWindow(window, ckSchedule, [ck], [ckActualPaycheck]);
    expect(income).toBe(1650);

    const heavySweep = computeSweepAmount(income, heavyBills, categoryBudgets);
    const lightSweep = computeSweepAmount(income, lightBills, categoryBudgets);

    expect(heavySweep).toBe(1650 - 760 - 200); // 690
    expect(lightSweep).toBe(1650 - 0 - 200); // 1450
    // Same income, same category budgets passed to both calls — only the
    // bill total differs, and that's exactly what moved.
    expect(lightSweep - heavySweep).toBe(760);
  });
});

describe("computeIncomeForWindow — multi-source aggregation", () => {
  it("adds a non-primary regular source's (Church) paychecks — Actual once known, Expected while still projected", () => {
    const churchActual: Paycheck = {
      id: "pc-church-1",
      incomeSourceId: "src-church",
      payDate: "2026-01-04",
      autoSplitAmount: 0,
      net: 210,
      isActual: true,
    };
    const churchExpected: Paycheck = {
      id: "pc-church-2",
      incomeSourceId: "src-church",
      payDate: "2026-01-11",
      autoSplitAmount: 0,
      net: 0,
      expectedPerPaycheck: 200,
      isActual: false,
    };

    const income = computeIncomeForWindow(
      window,
      ckSchedule,
      [ck, church],
      [ckActualPaycheck, churchActual, churchExpected]
    );

    expect(income).toBe(1650 + 210 + 200);
  });

  it("adds an irregular (gig) source's actual deposits only — no expected contribution before a deposit lands", () => {
    const gigActual: Paycheck = {
      id: "pc-gig-1",
      incomeSourceId: "src-gig",
      payDate: "2026-01-08",
      autoSplitAmount: 0,
      net: 300,
      isActual: true,
    };
    const gigNotYetActual: Paycheck = {
      id: "pc-gig-2",
      incomeSourceId: "src-gig",
      payDate: "2026-01-10",
      autoSplitAmount: 0,
      net: 0,
      expectedPerPaycheck: 999, // irregular sources don't get an expected value; must be ignored
      isActual: false,
    };

    const income = computeIncomeForWindow(
      window,
      ckSchedule,
      [ck, gig],
      [ckActualPaycheck, gigActual, gigNotYetActual]
    );

    expect(income).toBe(1650 + 300 + 0);
  });
});

describe("getBillsInWindow", () => {
  it("only includes bills whose due date falls inside the given canonical window", () => {
    const bills: Bill[] = [
      { id: "bill-in", name: "Rent", amount: 700, dueDate: "2026-01-05", paidStatus: false, type: "bill" },
      { id: "bill-out", name: "Next window's bill", amount: 50, dueDate: "2026-01-20", paidStatus: false, type: "bill" },
    ];
    const result = getBillsInWindow(bills, window, ckSchedule);
    expect(result.map((b) => b.id)).toEqual(["bill-in"]);
  });
});
