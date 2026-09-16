// Shared domain types for BASELINE v2 rv2.1.
//
// These mirror supabase/migrations/0001_init.sql. Dates are represented as
// ISO "YYYY-MM-DD" strings throughout the domain layer (not JS Date) so
// window arithmetic is unambiguous regardless of timezone — conversion to
// Date only happens inside payWindow.ts's internal calculations.

export type IsoDate = string; // "YYYY-MM-DD"

export type AccountRole =
  | "primary_pay"
  | "savings"
  | "hsa"
  | "credit_card"
  | "business"
  | "other_manual";

export interface Account {
  id: string;
  name: string;
  role: AccountRole;
  isManual: boolean;
}

export type IncomeSourceType = "regular" | "irregular";

export interface IncomeSource {
  id: string;
  name: string;
  type: IncomeSourceType;
  /** At most one income source has this true; exactly one is required by
   * application validation before canonical-window math runs. */
  isPrimaryWindowSource: boolean;
  /** Regular sources only — the Setup baseline used by
   * projectExpectedPaychecks to forecast future paycheck events. */
  expectedPerPaycheck?: number;
  /** Irregular sources only — a monthly planning estimate, never a
   * per-paycheck expectation (irregular income has no schedule to attach
   * a per-paycheck figure to). */
  expectedMonthly?: number;
}

export type PayCadence = "weekly" | "biweekly" | "semimonthly";

export interface PaySchedule {
  id: string;
  incomeSourceId: string;
  cadence: PayCadence;
  /** weekly/biweekly only — exact 7- or 14-day interval off this date. */
  anchorDate?: IsoDate;
  /** semimonthly only — explicit day-of-month pair, 1-31, 0 = last day of
   * month. Never used as the canonical schedule. */
  semimonthlyDayA?: number;
  semimonthlyDayB?: number;
}

/**
 * A single paycheck EVENT, which may carry a projected side, an actual
 * side, or both — never collapsed into one field. This is what lets a
 * reconciled paycheck keep its original forecast (date/amount) alongside
 * the real deposit once Plaid confirms it, for variance/history, rather
 * than overwriting the projection in place.
 *
 * `isActual` is the reconciliation status: false = still a forecast
 * (projected* fields authoritative), true = reconciled (actual* fields
 * authoritative for all downstream math and canonical-window assignment).
 * Regular sources get a projected side from projectExpectedPaychecks();
 * irregular (gig) sources never do — they only ever have an actual side,
 * created once a real deposit is known.
 */
export interface Paycheck {
  id: string;
  incomeSourceId: string;
  /** Forecast date/amount at the time this event was projected. Regular
   * sources only. */
  projectedPayDate?: IsoDate;
  projectedAmount?: number;
  /** Real deposit date/amount once reconciled. Required when isActual is
   * true; absent otherwise. */
  actualPayDate?: IsoDate;
  actualAmount?: number;
  actualGross?: number;
  autoSplitAmount: number;
  autoSplitDestinationAccountId?: string;
  isActual: boolean;
}

export type CategoryRolloverMode = "rollover" | "sweep";

export interface Category {
  id: string;
  name: string;
  parentCategoryId?: string;
  rolloverMode: CategoryRolloverMode;
  isIncomeCategory: boolean;
}

/** A per-canonical-window baseline amount for a category, effective-dated
 * so budget changes are tracked rather than silently re-divided. */
export interface CategoryWindowBudget {
  id: string;
  categoryId: string;
  amount: number;
  effectiveFrom: IsoDate;
}

export type BillType = "bill" | "subscription";

export interface Bill {
  id: string;
  name: string;
  amount: number;
  dueDate: IsoDate;
  paidStatus: boolean;
  type: BillType;
}

export interface SinkingFund {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  priority: number;
  fundingAccountId?: string;
}

export interface Debt {
  id: string;
  name: string;
  balance: number;
  apr?: number;
  minimumPayment?: number;
}

export interface Transaction {
  id: string;
  accountId: string;
  postedDate: IsoDate;
  pending: boolean;
  amount: number;
  description: string;
  categoryId?: string;
  isTransfer: boolean;
}

/** A canonical operating window: Window N = [start, end), inclusive start,
 * exclusive end. Always derived from the primary/canonical income
 * source's pay_schedule — never any other source's. */
export interface CanonicalWindow {
  start: IsoDate;
  end: IsoDate;
}
