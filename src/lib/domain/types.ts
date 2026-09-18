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
  /** Set once linked via Plaid. Absent for manual accounts. */
  plaidAccountId?: string;
  plaidItemId?: string;
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
  /** Set once linked via Plaid Liabilities. Absent for manually-entered debts. */
  plaidLiabilityId?: string;
}

/**
 * A transaction's raw source fields are set once at creation and NEVER
 * overwritten by any later correction (merchant re-teaching, category
 * fix, etc.) — they're what "the source actually said," preserved
 * separately from whatever normalization/correction happens afterward.
 * Pre-Plaid, rawMerchantName/rawCategory are typically unset since
 * there's no external enrichment to diverge from yet; Step 5 (Plaid)
 * populates them.
 */
export interface Transaction {
  id: string;
  accountId: string;
  /** Operative date for canonical-window assignment (see payWindow.ts)
   * and calendar reporting. Distinct from rawDate below — nothing in the
   * window/budget domain layer reads rawDate. */
  postedDate: IsoDate;
  pending: boolean;
  amount: number;
  description: string;
  categoryId?: string;
  isTransfer: boolean;

  // Raw source fields — immutable once set.
  rawDescription: string;
  rawMerchantName?: string;
  rawCategory?: string;
  rawAmount: number;
  rawDate: IsoDate;

  // Normalized/user-corrected fields — these are what change.
  /** Resolved merchant identity for display and merchant-memory matching
   * output. Never an input to rule lookup — see merchantMemory.ts. */
  normalizedMerchantName?: string;
  /** True when no merchant rule matched at categorization time. */
  needsReview: boolean;

  /** Manual link to a Bill/Subscription record. Auto-matching is Step 7 —
   * this pass only adds the field + a manual linking helper. */
  billId?: string;
  /** Shared id pairing this transaction with its other leg once
   * confirmed as an internal transfer. See transferDetection.ts. */
  transferLinkId?: string;

  /** Plaid's stable transaction_id. The idempotency key for sync — see
   * plaidSync.ts. Absent for manually-entered transactions. When a
   * pending transaction posts, Plaid issues a NEW transaction_id, so
   * this field changes in place on reconciliation (see
   * reconcilePendingToPosted) while our own `id` above never does. */
  plaidTransactionId?: string;
  /** Plaid's pending_transaction_id on a just-posted transaction,
   * pointing back at the pending transaction_id it replaces. Only
   * meaningful transiently, during sync — see plaidSync.ts. */
  plaidPendingTransactionId?: string;
}

/** One category's share of a split transaction. A transaction with splits
 * has one or more of these, whose amounts must sum exactly to the parent
 * transaction's amount (see transactionSplits.ts). */
export interface TransactionSplit {
  id: string;
  transactionId: string;
  categoryId: string;
  amount: number;
}

/** One row per normalized merchant identity, mapping it to the category
 * the user confirmed. merchantKey is always derived from a transaction's
 * raw fields (see merchantMemory.ts) — never from normalizedMerchantName,
 * so renaming a merchant's display never changes which rule applies. */
export interface MerchantRule {
  id: string;
  merchantKey: string;
  categoryId: string;
}

/** Confirmed-transfer history for one unordered pair of accounts, keyed
 * via canonicalAccountPairKey so lookup doesn't depend on argument order.
 * Growing confirmedCount is what lets future matches on the same pair
 * gain confidence over time (see transferDetection.ts). */
export interface TransferPairHistory {
  id: string;
  accountAId: string;
  accountBId: string;
  confirmedCount: number;
}

export type TransferConfidence = "high" | "low" | "none";

export interface TransferCandidate {
  transactionAId: string;
  transactionBId: string;
  confidence: TransferConfidence;
  score: number;
}

/** A canonical operating window: Window N = [start, end), inclusive start,
 * exclusive end. Always derived from the primary/canonical income
 * source's pay_schedule — never any other source's. */
export interface CanonicalWindow {
  start: IsoDate;
  end: IsoDate;
}

// ============================================================================
// Plaid integration (rv2.4, Step 5)
// ============================================================================

export type PlaidItemStatus = "active" | "login_required" | "error";

/**
 * One linked institution connection. Deliberately has NO access_token
 * field — that lives only in a server-only shape inside src/lib/plaid/,
 * never in this shared type, so nothing under src/app or src/components
 * can accidentally receive or serialize it. See plaidSync.ts and
 * syncOrchestration.ts.
 */
export interface PlaidItem {
  id: string;
  userId: string;
  plaidItemId: string;
  institutionName?: string;
  status: PlaidItemStatus;
  errorCode?: string;
  /** Cursor for /transactions/sync — advanced only after a complete sync
   * batch has been fetched AND successfully persisted. */
  transactionsCursor?: string;
  lastSuccessfulSyncAt?: IsoDate;
  /** Set when a SYNC_UPDATES_AVAILABLE webhook's payload carries
   * historical_update_complete: true — always as a side effect of that
   * same sync call, never set in place of running it. */
  historicalPullComplete?: boolean;
}

/** The Step 6 hook: a raw balance-as-reported-by-Plaid snapshot. No
 * roll-forward projection or offset reconciliation reads this yet — that
 * logic is Step 6, not built here. */
export interface AccountBalanceSnapshot {
  id: string;
  accountId: string;
  asOfBalance: number;
  asOfTimestamp: string; // ISO 8601 timestamp, not just a date
}

/** The subset of a Plaid transaction object this app consumes. Mirrors
 * Plaid's own field names/shapes (snake_case in Plaid's actual API;
 * camelCase here since this is our mapped intermediate shape, not the
 * wire format). Amount sign convention matches Plaid's own: positive =
 * outflow, negative = inflow — same convention transferDetection.ts
 * already uses, so no conversion is needed anywhere in this pipeline. */
export interface PlaidTransactionData {
  transactionId: string;
  pendingTransactionId?: string;
  plaidAccountId: string;
  amount: number;
  date: IsoDate;
  pending: boolean;
  merchantName?: string;
  name: string;
  category?: string[];
}

export interface PlaidSyncBatch {
  added: PlaidTransactionData[];
  modified: PlaidTransactionData[];
  removed: { transactionId: string }[];
}

export interface SyncResult {
  transactions: Transaction[];
  created: number;
  updated: number;
  reconciledPendingToPosted: number;
  removed: number;
}

/** The subset of a Plaid account object this app consumes, for
 * create-or-update account persistence (see syncPlaidAccounts). */
export interface PlaidAccountData {
  plaidAccountId: string;
  name: string;
  /** Plaid's AccountType: "depository" | "credit" | "loan" | "investment" | "other". */
  type: string;
  subtype?: string;
}

export interface PlaidLiabilityData {
  plaidLiabilityId: string;
  currentBalance: number;
  apr?: number;
  minimumPaymentAmount?: number;
  /** From the paired /accounts/get response, when creating a new Debt. */
  accountName?: string;
}
