import { describe, expect, it } from "vitest";
import { projectExpectedPaychecks } from "@/lib/domain/paycheck";
import type { IncomeSource, PaySchedule } from "@/lib/domain/types";

describe("projectExpectedPaychecks", () => {
  it("follows Circle K's exact biweekly anchor cadence", () => {
    const ck: IncomeSource = {
      id: "src-ck",
      name: "Circle K",
      type: "regular",
      isPrimaryWindowSource: true,
      expectedPerPaycheck: 1650,
    };
    const ckSchedule: PaySchedule = {
      id: "sched-ck",
      incomeSourceId: "src-ck",
      cadence: "biweekly",
      anchorDate: "2026-01-02",
    };

    const projected = projectExpectedPaychecks(ck, ckSchedule, "2026-01-02", "2026-02-27");

    expect(projected.map((p) => p.projectedPayDate)).toEqual([
      "2026-01-02",
      "2026-01-16",
      "2026-01-30",
      "2026-02-13",
      "2026-02-27",
    ]);
    expect(projected.every((p) => p.projectedAmount === 1650)).toBe(true);
    expect(projected.every((p) => p.isActual === false)).toBe(true);
    expect(projected.every((p) => p.incomeSourceId === "src-ck")).toBe(true);
  });

  it("follows Church's own regular (weekly) cadence, independent of Circle K's", () => {
    const church: IncomeSource = {
      id: "src-church",
      name: "Church",
      type: "regular",
      isPrimaryWindowSource: false,
      expectedPerPaycheck: 200,
    };
    const churchSchedule: PaySchedule = {
      id: "sched-church",
      incomeSourceId: "src-church",
      cadence: "weekly",
      anchorDate: "2026-01-04",
    };

    const projected = projectExpectedPaychecks(church, churchSchedule, "2026-01-04", "2026-01-25");

    expect(projected.map((p) => p.projectedPayDate)).toEqual([
      "2026-01-04",
      "2026-01-11",
      "2026-01-18",
      "2026-01-25",
    ]);
    expect(projected.every((p) => p.projectedAmount === 200)).toBe(true);
  });

  it("generates a semimonthly source's two explicit calendar paydays per month, including the last-day-of-month sentinel", () => {
    const semiSource: IncomeSource = {
      id: "src-semi",
      name: "Semimonthly gig",
      type: "regular",
      isPrimaryWindowSource: false,
      expectedPerPaycheck: 500,
    };
    const semiSchedule: PaySchedule = {
      id: "sched-semi",
      incomeSourceId: "src-semi",
      cadence: "semimonthly",
      semimonthlyDayA: 15,
      semimonthlyDayB: 0, // last day of month
    };

    const projected = projectExpectedPaychecks(semiSource, semiSchedule, "2026-01-01", "2026-02-28");

    expect(projected.map((p) => p.projectedPayDate)).toEqual([
      "2026-01-15",
      "2026-01-31",
      "2026-02-15",
      "2026-02-28", // Feb 2026 is not a leap year — last day resolves to 28, not 30/31
    ]);
  });

  it("produces no projected events for an irregular (gig) source — it has no cadence to project from", () => {
    const gig: IncomeSource = {
      id: "src-gig",
      name: "Gig",
      type: "irregular",
      isPrimaryWindowSource: false,
      expectedMonthly: 400,
    };
    // Even if a pay_schedule were somehow attached, irregular sources
    // never generate projections — the type guard is the first check.
    const bogusSchedule: PaySchedule = {
      id: "sched-gig",
      incomeSourceId: "src-gig",
      cadence: "biweekly",
      anchorDate: "2026-01-02",
    };

    expect(projectExpectedPaychecks(gig, bogusSchedule, "2026-01-01", "2026-03-01")).toEqual([]);
  });

  it("produces no projected events when a regular source has no expected_per_paycheck baseline set", () => {
    const regularNoBaseline: IncomeSource = {
      id: "src-x",
      name: "New job, not configured yet",
      type: "regular",
      isPrimaryWindowSource: false,
    };
    const schedule: PaySchedule = {
      id: "sched-x",
      incomeSourceId: "src-x",
      cadence: "weekly",
      anchorDate: "2026-01-02",
    };

    expect(projectExpectedPaychecks(regularNoBaseline, schedule, "2026-01-01", "2026-03-01")).toEqual([]);
  });
});
