import { describe, expect, it } from "vitest";
import { getEffectiveAmount, getEffectivePayDate, reconcilePaycheck } from "@/lib/domain/paycheck";
import { computeIncomeForWindow } from "@/lib/domain/sweep";
import type { IncomeSource, Paycheck, PaySchedule } from "@/lib/domain/types";

const ckSchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

const windowContainingJan11 = { start: "2026-01-02", end: "2026-01-16" };
const windowContainingJan17 = { start: "2026-01-16", end: "2026-01-30" };

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

const churchProjected: Paycheck = {
  id: "pc-church-2",
  incomeSourceId: "src-church",
  autoSplitAmount: 0,
  projectedPayDate: "2026-01-11",
  projectedAmount: 200,
  isActual: false,
};

describe("reconcilePaycheck — preserves the forecast", () => {
  it("keeps projectedPayDate/projectedAmount untouched after reconciling", () => {
    const reconciled = reconcilePaycheck(churchProjected, "2026-01-17", 205);
    expect(reconciled.projectedPayDate).toBe("2026-01-11");
    expect(reconciled.projectedAmount).toBe(200);
    expect(reconciled.actualPayDate).toBe("2026-01-17");
    expect(reconciled.actualAmount).toBe(205);
    expect(reconciled.isActual).toBe(true);
  });

  it("getEffectivePayDate/getEffectiveAmount read the projected side before reconciliation, actual side after", () => {
    expect(getEffectivePayDate(churchProjected)).toBe("2026-01-11");
    expect(getEffectiveAmount(churchProjected)).toBe(200);

    const reconciled = reconcilePaycheck(churchProjected, "2026-01-17", 205);
    expect(getEffectivePayDate(reconciled)).toBe("2026-01-17");
    expect(getEffectiveAmount(reconciled)).toBe(205);
  });
});

describe("reconciliation and canonical-window assignment — Rob's Church example", () => {
  // Church projected: Jan 11 / $200. Church actual: Jan 17 / $205.
  it("counts the projected amount in the ORIGINAL window before reconciliation", () => {
    const income = computeIncomeForWindow(windowContainingJan11, ckSchedule, [ck, church], [churchProjected]);
    expect(income).toBe(200);

    const incomeInNextWindow = computeIncomeForWindow(
      windowContainingJan17,
      ckSchedule,
      [ck, church],
      [churchProjected]
    );
    expect(incomeInNextWindow).toBe(0);
  });

  it("expected and actual falling in the SAME canonical window: a normal on-time reconciliation", () => {
    const reconciledSameWindow = reconcilePaycheck(churchProjected, "2026-01-12", 200); // still Jan 2-16
    const income = computeIncomeForWindow(
      windowContainingJan11,
      ckSchedule,
      [ck, church],
      [reconciledSameWindow]
    );
    expect(income).toBe(200);
  });

  it("actual amount differing from expected, same window", () => {
    const reconciledDifferentAmount = reconcilePaycheck(churchProjected, "2026-01-12", 215);
    const income = computeIncomeForWindow(
      windowContainingJan11,
      ckSchedule,
      [ck, church],
      [reconciledDifferentAmount]
    );
    expect(income).toBe(215);
  });

  it("actual date crossing into a DIFFERENT canonical window: the projected contribution disappears from the original window, the actual contribution appears in the new one, and it is never counted in both", () => {
    const reconciled = reconcilePaycheck(churchProjected, "2026-01-17", 205);

    const incomeInOriginalWindow = computeIncomeForWindow(
      windowContainingJan11,
      ckSchedule,
      [ck, church],
      [reconciled]
    );
    const incomeInNewWindow = computeIncomeForWindow(
      windowContainingJan17,
      ckSchedule,
      [ck, church],
      [reconciled]
    );

    expect(incomeInOriginalWindow).toBe(0); // the $200 projection no longer counts here
    expect(incomeInNewWindow).toBe(205); // the $205 actual counts here instead

    // No double counting across the two windows combined.
    expect(incomeInOriginalWindow + incomeInNewWindow).toBe(205);
  });

  it("does not double count across a larger set of windows even when other paychecks are present", () => {
    const ckActual: Paycheck = {
      id: "pc-ck-1",
      incomeSourceId: "src-ck",
      autoSplitAmount: 0,
      actualPayDate: "2026-01-02",
      actualAmount: 1650,
      isActual: true,
    };
    const reconciled = reconcilePaycheck(churchProjected, "2026-01-17", 205);
    const allPaychecks = [ckActual, reconciled];

    const totalAcrossBothWindows =
      computeIncomeForWindow(windowContainingJan11, ckSchedule, [ck, church], allPaychecks) +
      computeIncomeForWindow(windowContainingJan17, ckSchedule, [ck, church], allPaychecks);

    // CK's 1650 (window 1) + Church's actual 205 (window 2), each counted exactly once.
    expect(totalAcrossBothWindows).toBe(1650 + 205);
  });
});
