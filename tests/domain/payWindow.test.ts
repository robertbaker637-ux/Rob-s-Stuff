import { describe, expect, it } from "vitest";
import {
  assignDateToCanonicalWindow,
  computeCanonicalWindow,
  getWindowsOverlappingMonth,
} from "@/lib/domain/payWindow";
import type { PaySchedule } from "@/lib/domain/types";

// Circle K: real biweekly Friday payroll, anchor Fri 2026-01-02. This
// single anchor naturally produces both a 3-payday calendar month
// (January: Jan 2, Jan 16, Jan 30) and a window spanning a month boundary
// (Feb 27 - Mar 13), so the same fixture covers both edge cases the plan
// calls out without any contrived dates.
const ckSchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

describe("computeCanonicalWindow", () => {
  it("returns the exact 14-day window starting at the anchor itself", () => {
    expect(computeCanonicalWindow(ckSchedule, "2026-01-02")).toEqual({
      start: "2026-01-02",
      end: "2026-01-16",
    });
  });

  it("keeps the same window for every date up to (not including) the next payday", () => {
    expect(computeCanonicalWindow(ckSchedule, "2026-01-15")).toEqual({
      start: "2026-01-02",
      end: "2026-01-16",
    });
    expect(computeCanonicalWindow(ckSchedule, "2026-01-16")).toEqual({
      start: "2026-01-16",
      end: "2026-01-30",
    });
  });

  it("computes windows correctly before the anchor date (negative offsets)", () => {
    expect(computeCanonicalWindow(ckSchedule, "2025-12-25")).toEqual({
      start: "2025-12-19",
      end: "2026-01-02",
    });
  });

  it("keeps a window whole across a calendar-month boundary — no reset on the 1st", () => {
    // The Jan 30 -> Feb 13 window spans January/February.
    const lastDayOfJan = computeCanonicalWindow(ckSchedule, "2026-01-31");
    const firstDayOfFeb = computeCanonicalWindow(ckSchedule, "2026-02-01");
    expect(lastDayOfJan).toEqual({ start: "2026-01-30", end: "2026-02-13" });
    expect(firstDayOfFeb).toEqual(lastDayOfJan);
  });

  it("keeps a window whole across a month boundary further into the year (Feb 27 - Mar 13)", () => {
    const feb28 = computeCanonicalWindow(ckSchedule, "2026-02-28");
    const mar1 = computeCanonicalWindow(ckSchedule, "2026-03-01");
    expect(feb28).toEqual({ start: "2026-02-27", end: "2026-03-13" });
    expect(mar1).toEqual(feb28);
  });

  it("throws for a semimonthly schedule — semimonthly can never be canonical", () => {
    const semimonthly: PaySchedule = {
      id: "sched-x",
      incomeSourceId: "src-x",
      cadence: "semimonthly",
      semimonthlyDayA: 1,
      semimonthlyDayB: 15,
    };
    expect(() => computeCanonicalWindow(semimonthly, "2026-01-10")).toThrow();
  });
});

describe("assignDateToCanonicalWindow", () => {
  it("buckets an arbitrary date (e.g. another income source's deposit) into the containing canonical window", () => {
    expect(assignDateToCanonicalWindow("2026-01-20", ckSchedule)).toEqual({
      start: "2026-01-16",
      end: "2026-01-30",
    });
  });
});

describe("getWindowsOverlappingMonth", () => {
  it("finds four overlapping windows for January 2026 — three real paydays (Jan 2/16/30) plus the Dec 19 window's one-day tail on Jan 1", () => {
    const windows = getWindowsOverlappingMonth(ckSchedule, 2026, 1);
    expect(windows).toEqual([
      { start: "2025-12-19", end: "2026-01-02" },
      { start: "2026-01-02", end: "2026-01-16" },
      { start: "2026-01-16", end: "2026-01-30" },
      { start: "2026-01-30", end: "2026-02-13" },
    ]);
    // Windows overlapping a month are not the same thing as paydays
    // landing in it (that distinction is exactly why category budgets are
    // never divided by "paydays in month" — see categoryAllocation.ts).
    // Only 3 of these 4 windows actually open with a payday inside January.
    const paydaysInJanuary = windows.filter(
      (w) => w.start >= "2026-01-01" && w.start <= "2026-01-31"
    );
    expect(paydaysInJanuary).toHaveLength(3);
  });

  it("finds three overlapping windows for February 2026 (one carried in from January, one carried into March)", () => {
    const windows = getWindowsOverlappingMonth(ckSchedule, 2026, 2);
    expect(windows).toEqual([
      { start: "2026-01-30", end: "2026-02-13" },
      { start: "2026-02-13", end: "2026-02-27" },
      { start: "2026-02-27", end: "2026-03-13" },
    ]);
  });
});
