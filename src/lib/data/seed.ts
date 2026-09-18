// Manually-seeded household fixture (rv2.1, extended in rv2.2 and rv2.3).
//
// Enough hand-entered data to validate the domain math end to end and to
// drive the UI shell before any real Plaid/Supabase connection exists.
// Circle K is biweekly Fridays and is the canonical window source; Church
// is a second regular income source on its own weekly cadence; Gig is
// irregular. See src/lib/domain for how these combine.
//
// Coverage: five consecutive canonical windows (2026-01-02 through
// 2026-03-13), spanning January's real 3-payday month, February's normal
// 2-payday month, and a window (Jan 30 - Feb 13) that crosses the
// calendar-month boundary with real spending on both sides. Circle K and
// Church paychecks are generated from their own pay_schedules via
// projectExpectedPaychecks (not hand-written one by one), then the ones
// that have already happened as of SEED_TODAY are reconciled via
// reconcilePaycheck — including one that lands in a different canonical
// window than it was originally projected into (Church's Jan 11
// projection, actually deposited Jan 17).
//
// rv2.3 (Step 4, transaction model): txn-1..txn-8 are UNCHANGED in
// behavior — only the new required raw_*/needsReview fields were added
// mechanically (raw mirrors normalized, since these were entered as
// already-reviewed). Everything from txn-9 onward is new: a
// merchant-memory example (generated via applyMerchantMemory, not
// hand-categorized), a split transaction, and a confirmed + an
// unconfirmed transfer-detection pair, so all four Step 4 behaviors are
// visible in the fixture, not just in isolated unit tests.

import { projectExpectedPaychecks, reconcilePaycheck } from "@/lib/domain/paycheck";
import { applyMerchantMemory, normalizeMerchantKey } from "@/lib/domain/merchantMemory";
import { confirmTransferLink } from "@/lib/domain/transferDetection";
import type {
  Account,
  Bill,
  Category,
  CategoryWindowBudget,
  Debt,
  IncomeSource,
  MerchantRule,
  Paycheck,
  PaySchedule,
  SinkingFund,
  Transaction,
  TransactionSplit,
  TransferPairHistory,
} from "@/lib/domain/types";

export const seedAccounts: Account[] = [
  { id: "acct-checking", name: "Primary Checking", role: "primary_pay", isManual: true },
  { id: "acct-savings", name: "Savings", role: "savings", isManual: true },
  { id: "acct-hsa", name: "HSA", role: "hsa", isManual: true },
  { id: "acct-cc", name: "Credit Card", role: "credit_card", isManual: true },
];

export const seedIncomeSources: IncomeSource[] = [
  {
    id: "src-ck",
    name: "Circle K",
    type: "regular",
    isPrimaryWindowSource: true,
    expectedPerPaycheck: 1650,
  },
  {
    id: "src-church",
    name: "Church",
    type: "regular",
    isPrimaryWindowSource: false,
    expectedPerPaycheck: 200,
  },
  {
    id: "src-gig",
    name: "Gig / Consulting",
    type: "irregular",
    isPrimaryWindowSource: false,
    expectedMonthly: 400,
  },
];

const ckSource = seedIncomeSources[0];
const churchSource = seedIncomeSources[1];

/** Circle K's schedule is the household's one canonical window structure. */
export const canonicalPaySchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

export const churchPaySchedule: PaySchedule = {
  id: "sched-church",
  incomeSourceId: "src-church",
  cadence: "weekly",
  anchorDate: "2026-01-04",
};

export const seedPaySchedules: PaySchedule[] = [canonicalPaySchedule, churchPaySchedule];

// Project every CK/Church paycheck event through five canonical windows
// (CK paydays Jan 2/16/30, Feb 13/27 — the last two open February's
// normal 2-payday month). generatePayDates covers the boundary window
// (Jan 30 - Feb 13) and beyond in one call, from each source's own
// schedule — nobody hand-wrote these dates.
const PROJECTION_THROUGH = "2026-02-27";
const projectedCk = projectExpectedPaychecks(ckSource, canonicalPaySchedule, "2026-01-02", PROJECTION_THROUGH);
const projectedChurch = projectExpectedPaychecks(
  churchSource,
  churchPaySchedule,
  "2026-01-04",
  PROJECTION_THROUGH
);

function findProjected(projected: Paycheck[], payDate: string): Paycheck {
  const found = projected.find((p) => p.projectedPayDate === payDate);
  if (!found) throw new Error(`No projected paycheck for ${payDate} — check the schedule/range.`);
  return found;
}

// As of SEED_TODAY (2026-02-05, see src/lib/ui/seedToday.ts), everything
// through Feb 1 has actually happened and is reconciled below; everything
// after that is still a live forecast, exactly as projected.
export const seedPaychecks: Paycheck[] = [
  // Circle K: Jan 2/16/30 already happened; Feb 13/27 still projected.
  reconcilePaycheck(findProjected(projectedCk, "2026-01-02"), "2026-01-02", 1650, 2000),
  reconcilePaycheck(findProjected(projectedCk, "2026-01-16"), "2026-01-16", 1660, 2020), // small OT bump
  reconcilePaycheck(findProjected(projectedCk, "2026-01-30"), "2026-01-30", 1650, 2000),
  findProjected(projectedCk, "2026-02-13"),
  findProjected(projectedCk, "2026-02-27"),

  // Church: Jan 4 through Feb 1 already happened; Feb 8/15/22 still
  // projected. Jan 11's projection was for the Jan 2-16 canonical window,
  // but the real deposit landed Jan 17 — inside the NEXT window (Jan
  // 16-30) — at $205 instead of the $200 expected. Reconciling it here
  // moves its effective window assignment automatically; it no longer
  // counts toward Jan 2-16 at all (see paycheckReconciliation.test.ts).
  reconcilePaycheck(findProjected(projectedChurch, "2026-01-04"), "2026-01-04", 210),
  reconcilePaycheck(findProjected(projectedChurch, "2026-01-11"), "2026-01-17", 205),
  reconcilePaycheck(findProjected(projectedChurch, "2026-01-18"), "2026-01-18", 198),
  reconcilePaycheck(findProjected(projectedChurch, "2026-01-25"), "2026-01-25", 200),
  reconcilePaycheck(findProjected(projectedChurch, "2026-02-01"), "2026-02-01", 202),
  findProjected(projectedChurch, "2026-02-08"),
  findProjected(projectedChurch, "2026-02-15"),
  findProjected(projectedChurch, "2026-02-22"),

  // Gig: irregular, no projection of its own — only actual deposits,
  // manually recorded, both already happened as of SEED_TODAY.
  {
    id: "pc-gig-1",
    incomeSourceId: "src-gig",
    autoSplitAmount: 0,
    actualPayDate: "2026-01-08",
    actualAmount: 300,
    isActual: true,
  },
  {
    id: "pc-gig-2",
    incomeSourceId: "src-gig",
    autoSplitAmount: 0,
    actualPayDate: "2026-02-04",
    actualAmount: 275,
    isActual: true,
  },
];

export const seedCategories: Category[] = [
  { id: "cat-groceries", name: "Groceries", rolloverMode: "rollover", isIncomeCategory: false },
  { id: "cat-utilities", name: "Utilities", rolloverMode: "rollover", isIncomeCategory: false },
  { id: "cat-fun", name: "Fun Money", rolloverMode: "sweep", isIncomeCategory: false },
  // Added in rv2.3 as the second leg of the split-transaction example below.
  { id: "cat-household", name: "Household", rolloverMode: "rollover", isIncomeCategory: false },
];

export const seedCategoryWindowBudgets: CategoryWindowBudget[] = [
  { id: "b-groceries", categoryId: "cat-groceries", amount: 150, effectiveFrom: "2025-01-01" },
  { id: "b-utilities", categoryId: "cat-utilities", amount: 50, effectiveFrom: "2025-01-01" },
  { id: "b-fun", categoryId: "cat-fun", amount: 40, effectiveFrom: "2025-01-01" },
  { id: "b-household", categoryId: "cat-household", amount: 60, effectiveFrom: "2025-01-01" },
];

export const seedBills: Bill[] = [
  // Window 1 (Jan 2-16)
  { id: "bill-rent", name: "Rent", amount: 700, dueDate: "2026-01-05", paidStatus: true, type: "bill" },
  { id: "bill-internet", name: "Internet", amount: 60, dueDate: "2026-01-12", paidStatus: true, type: "bill" },
  // Window 2 (Jan 16-30)
  { id: "bill-netflix", name: "Netflix", amount: 15.49, dueDate: "2026-01-18", paidStatus: true, type: "subscription" },
  { id: "bill-phone", name: "Phone", amount: 45, dueDate: "2026-01-25", paidStatus: true, type: "bill" },
  // Window 3 (Jan 30 - Feb 13, crosses the month boundary)
  { id: "bill-car-insurance", name: "Car Insurance", amount: 85, dueDate: "2026-02-05", paidStatus: false, type: "bill" },
];

export const seedSinkingFunds: SinkingFund[] = [
  {
    id: "fund-emergency",
    name: "Emergency Fund",
    targetAmount: 5000,
    currentAmount: 1200,
    priority: 1,
    fundingAccountId: "acct-savings",
  },
  {
    id: "fund-car",
    name: "Car Repair",
    targetAmount: 1500,
    currentAmount: 300,
    priority: 2,
    fundingAccountId: "acct-savings",
  },
];

export const seedDebts: Debt[] = [
  { id: "debt-cc", name: "Credit Card", balance: 1200, apr: 22.99, minimumPayment: 35 },
];

// txn-1..txn-8: UNCHANGED behavior from rv2.1/rv2.2 — amount, postedDate,
// categoryId, isTransfer are byte-for-byte identical. Only the new
// required raw_*/needsReview fields were added mechanically (raw mirrors
// normalized, since these were entered as already-reviewed, pre-Plaid).
export const seedTransactions: Transaction[] = [
  // Window 1 (Jan 2-16)
  { id: "txn-1", accountId: "acct-checking", postedDate: "2026-01-06", pending: false, amount: 45, description: "Grocery Mart", categoryId: "cat-groceries", isTransfer: false, rawDescription: "Grocery Mart", rawAmount: 45, rawDate: "2026-01-06", needsReview: false },
  { id: "txn-2", accountId: "acct-checking", postedDate: "2026-01-10", pending: false, amount: 30, description: "Corner Grocer", categoryId: "cat-groceries", isTransfer: false, rawDescription: "Corner Grocer", rawAmount: 30, rawDate: "2026-01-10", needsReview: false },
  { id: "txn-3", accountId: "acct-checking", postedDate: "2026-01-09", pending: false, amount: 50, description: "Electric Co.", categoryId: "cat-utilities", isTransfer: false, rawDescription: "Electric Co.", rawAmount: 50, rawDate: "2026-01-09", needsReview: false },

  // Window 2 (Jan 16-30)
  { id: "txn-4", accountId: "acct-checking", postedDate: "2026-01-18", pending: false, amount: 35, description: "Grocery Mart", categoryId: "cat-groceries", isTransfer: false, rawDescription: "Grocery Mart", rawAmount: 35, rawDate: "2026-01-18", needsReview: false },
  { id: "txn-5", accountId: "acct-checking", postedDate: "2026-01-19", pending: false, amount: 48, description: "Electric Co.", categoryId: "cat-utilities", isTransfer: false, rawDescription: "Electric Co.", rawAmount: 48, rawDate: "2026-01-19", needsReview: false },

  // Window 3 (Jan 30 - Feb 13) — real spending on both sides of the Jan/Feb
  // boundary, inside the SAME canonical window. See
  // categoryAllocation.test.ts for the balance-carry assertion this backs.
  { id: "txn-6", accountId: "acct-checking", postedDate: "2026-01-31", pending: false, amount: 40, description: "Grocery Mart", categoryId: "cat-groceries", isTransfer: false, rawDescription: "Grocery Mart", rawAmount: 40, rawDate: "2026-01-31", needsReview: false },
  { id: "txn-7", accountId: "acct-checking", postedDate: "2026-02-03", pending: false, amount: 30, description: "Corner Grocer", categoryId: "cat-groceries", isTransfer: false, rawDescription: "Corner Grocer", rawAmount: 30, rawDate: "2026-02-03", needsReview: false },
  { id: "txn-8", accountId: "acct-checking", postedDate: "2026-02-04", pending: true, amount: 52, description: "Electric Co.", categoryId: "cat-utilities", isTransfer: false, rawDescription: "Electric Co.", rawAmount: 52, rawDate: "2026-02-04", needsReview: false },
];

// ============================================================================
// rv2.3 (Step 4) — merchant memory, split transactions, transfer detection
// ============================================================================

export const seedMerchantRules: MerchantRule[] = [
  { id: "rule-coffee-house", merchantKey: normalizeMerchantKey("Coffee House"), categoryId: "cat-fun" },
];

// Generated via applyMerchantMemory against seedMerchantRules above, not
// hand-categorized — this is the merchant-memory auto-categorization path
// actually exercised, not just described.
const coffeeHouseRaw: Transaction = {
  id: "txn-9",
  accountId: "acct-checking",
  postedDate: "2026-01-07",
  pending: false,
  amount: 6.5,
  description: "Coffee House",
  isTransfer: false,
  rawDescription: "Coffee House",
  rawMerchantName: "Coffee House",
  rawAmount: 6.5,
  rawDate: "2026-01-07",
  needsReview: true,
};
export const seedCoffeeHouseTransaction: Transaction = applyMerchantMemory(
  coffeeHouseRaw,
  seedMerchantRules
);

// A split transaction: one Target run divided across Groceries and
// Household. No top-level categoryId — its category is entirely defined
// by seedTransactionSplits below (see getEffectiveCategoryLineItems).
export const seedSplitTransaction: Transaction = {
  id: "txn-10",
  accountId: "acct-checking",
  postedDate: "2026-01-20",
  pending: false,
  amount: 90,
  description: "Target",
  isTransfer: false,
  rawDescription: "Target",
  rawAmount: 90,
  rawDate: "2026-01-20",
  needsReview: false,
};
export const seedTransactionSplits: TransactionSplit[] = [
  { id: "split-10-groceries", transactionId: "txn-10", categoryId: "cat-groceries", amount: 50 },
  { id: "split-10-household", transactionId: "txn-10", categoryId: "cat-household", amount: 40 },
];

// A confirmed, high-confidence transfer pair (exact amount, same day,
// checking -> savings) — run through confirmTransferLink so the fixture
// carries real linked/history state, not a hand-set transferLinkId.
const transferLegARaw: Transaction = {
  id: "txn-11",
  accountId: "acct-checking",
  postedDate: "2026-01-21",
  pending: false,
  amount: 200, // outflow
  description: "Transfer to Savings",
  isTransfer: false,
  rawDescription: "Transfer to Savings",
  rawAmount: 200,
  rawDate: "2026-01-21",
  needsReview: false,
};
const transferLegBRaw: Transaction = {
  id: "txn-12",
  accountId: "acct-savings",
  postedDate: "2026-01-21",
  pending: false,
  amount: -200, // inflow
  description: "Transfer from Checking",
  isTransfer: false,
  rawDescription: "Transfer from Checking",
  rawAmount: -200,
  rawDate: "2026-01-21",
  needsReview: false,
};
export const {
  txnA: seedConfirmedTransferLegA,
  txnB: seedConfirmedTransferLegB,
  pairHistory: seedTransferPairHistory,
}: { txnA: Transaction; txnB: Transaction; pairHistory: TransferPairHistory[] } = confirmTransferLink(
  transferLegARaw,
  transferLegBRaw,
  []
);

// An UNCONFIRMED, low-confidence candidate pair (near amount, a few days
// apart, on a different account pair with no prior history) — left
// exactly as findTransferCandidates/scoreTransferCandidate would surface
// it, still needing a one-tap confirmation. isTransfer stays false.
export const seedTransferCandidateLegA: Transaction = {
  id: "txn-13",
  accountId: "acct-checking",
  postedDate: "2026-01-22",
  pending: false,
  amount: 75,
  description: "Possible Transfer",
  isTransfer: false,
  rawDescription: "Possible Transfer",
  rawAmount: 75,
  rawDate: "2026-01-22",
  needsReview: true,
};
export const seedTransferCandidateLegB: Transaction = {
  id: "txn-14",
  accountId: "acct-hsa",
  postedDate: "2026-01-24",
  pending: false,
  amount: -74,
  description: "Possible Transfer In",
  isTransfer: false,
  rawDescription: "Possible Transfer In",
  rawAmount: -74,
  rawDate: "2026-01-24",
  needsReview: true,
};

seedTransactions.push(
  seedCoffeeHouseTransaction,
  seedSplitTransaction,
  seedConfirmedTransferLegA,
  seedConfirmedTransferLegB,
  seedTransferCandidateLegA,
  seedTransferCandidateLegB
);
