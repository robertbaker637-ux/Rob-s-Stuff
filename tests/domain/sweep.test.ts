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

const ck: IncomeSource = {
  id: "src-ck",
  name: "Circle K",
  type: "regular",
  isPrimaryWindowSource: true,
  expectedPerPaycheck: 1650,
};
const church: IncomeSource = {
  id: "src-church",
  name: "Church",
  type: "regular",
  isPrimaryWindowSource: false,
  expectedPerPaycheck: 200,
};
const gig: IncomeSource = {
  id: "src-gig",
  name: "Gig",
  type: "irregular",
  isPrimaryWindowSource: false,
  expectedMonthly: 400,
};

const categoryBudgets: CategoryWindowBudget[] = [
  { id: "b-groceries", categoryId: "cat-groceries", amount: 150, effectiveFrom: "2025-01-01" },
  { id: "b-utilities", categoryId: "cat-utilities", amount: 50, effectiveFrom: "2025-01-01" },
];

const ckActualPaycheck: Paycheck = {
  id: "pc-ck-1",
  incomeSourceId: "src-ck",
  autoSplitAmount: 0,
  actualPayDate: "2026-01-02",
  actualAmount: 1650,
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
    expect(lightSweep - heavySweep).toBe(760);
  });
});

describe("computeIncomeForWindow — multi-source aggregation", () => {
  it("adds a non-primary regular source's (Church) paychecks — Actual once known, Expected while still projected", () => {
    const churchActual: Paycheck = {
      id: "pc-church-1",
      incomeSourceId: "src-church",
      autoSplitAmount: 0,
      actualPayDate: "2026-01-04",
      actualAmount: 210,
      isActual: true,
    };
    const churchProjected: Paycheck = {
      id: "pc-church-2",
      incomeSourceId: "src-church",
      autoSplitAmount: 0,
      projectedPayDate: "2026-01-11",
      projectedAmount: 200,
      isActual: false,
    };

    const income = computeIncomeForWindow(
      window,
      ckSchedule,
      [ck, church],
      [ckActualPaycheck, churchActual, churchProjected]
    );

    expect(income).toBe(1650 + 210 + 200);
  });

  it("adds an irregular (gig) source's actual deposits only — no expected contribution before a deposit lands", () => {
    const gigActual: Paycheck = {
      id: "pc-gig-1",
      incomeSourceId: "src-gig",
      autoSplitAmount: 0,
      actualPayDate: "2026-01-08",
      actualAmount: 300,
      isActual: true,
    };
    // Defensive: a malformed non-actual gig row that somehow has
    // projected* fields set must still be ignored — irregular income
    // never gets a forecast, regardless of what's on the record.
    const gigMalformedProjected: Paycheck = {
      id: "pc-gig-2",
      incomeSourceId: "src-gig",
      autoSplitAmount: 0,
      projectedPayDate: "2026-01-10",
      projectedAmount: 999,
      isActual: false,
    };

    const income = computeIncomeForWindow(
      window,
      ckSchedule,
      [ck, gig],
      [ckActualPaycheck, gigActual, gigMalformedProjected]
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
