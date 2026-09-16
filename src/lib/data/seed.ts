// Manually-seeded household fixture (rv2.1).
//
// Enough hand-entered data to validate the domain math end to end and to
// drive the UI shell before any real Plaid/Supabase connection exists.
// Circle K is biweekly Fridays and is the canonical window source; Church
// is a second regular income source on its own weekly cadence; Gig is
// irregular. See src/lib/domain for how these combine.

import type {
  Account,
  Bill,
  Category,
  CategoryWindowBudget,
  Debt,
  IncomeSource,
  Paycheck,
  PaySchedule,
  SinkingFund,
  Transaction,
} from "@/lib/domain/types";

export const seedAccounts: Account[] = [
  { id: "acct-checking", name: "Primary Checking", role: "primary_pay", isManual: true },
  { id: "acct-savings", name: "Savings", role: "savings", isManual: true },
  { id: "acct-hsa", name: "HSA", role: "hsa", isManual: true },
  { id: "acct-cc", name: "Credit Card", role: "credit_card", isManual: true },
];

export const seedIncomeSources: IncomeSource[] = [
  { id: "src-ck", name: "Circle K", type: "regular", isPrimaryWindowSource: true },
  { id: "src-church", name: "Church", type: "regular", isPrimaryWindowSource: false },
  {
    id: "src-gig",
    name: "Gig / Consulting",
    type: "irregular",
    isPrimaryWindowSource: false,
    expectedMonthly: 400,
  },
];

/** Circle K's schedule is the household's one canonical window structure. */
export const canonicalPaySchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

export const seedPaySchedules: PaySchedule[] = [
  canonicalPaySchedule,
  {
    id: "sched-church",
    incomeSourceId: "src-church",
    cadence: "weekly",
    anchorDate: "2026-01-04",
  },
];

export const seedPaychecks: Paycheck[] = [
  // Circle K — one actual, one still projected (next payday).
  {
    id: "pc-ck-1",
    incomeSourceId: "src-ck",
    payDate: "2026-01-02",
    gross: 2000,
    autoSplitAmount: 350,
    autoSplitDestinationAccountId: "acct-savings",
    net: 1650,
    expectedPerPaycheck: 1650,
    isActual: true,
  },
  {
    id: "pc-ck-2",
    incomeSourceId: "src-ck",
    payDate: "2026-01-16",
    autoSplitAmount: 350,
    autoSplitDestinationAccountId: "acct-savings",
    net: 0,
    expectedPerPaycheck: 1650,
    isActual: false,
  },
  // Church — two paydays land inside the Jan 2-16 CK window (weekly cadence).
  {
    id: "pc-church-1",
    incomeSourceId: "src-church",
    payDate: "2026-01-04",
    autoSplitAmount: 0,
    net: 210,
    expectedPerPaycheck: 200,
    isActual: true,
  },
  {
    id: "pc-church-2",
    incomeSourceId: "src-church",
    payDate: "2026-01-11",
    autoSplitAmount: 0,
    net: 0,
    expectedPerPaycheck: 200,
    isActual: false,
  },
  // Gig — one actual deposit, no schedule/expectation of its own.
  {
    id: "pc-gig-1",
    incomeSourceId: "src-gig",
    payDate: "2026-01-08",
    autoSplitAmount: 0,
    net: 300,
    isActual: true,
  },
];

export const seedCategories: Category[] = [
  { id: "cat-groceries", name: "Groceries", rolloverMode: "rollover", isIncomeCategory: false },
  { id: "cat-utilities", name: "Utilities", rolloverMode: "rollover", isIncomeCategory: false },
  { id: "cat-fun", name: "Fun Money", rolloverMode: "sweep", isIncomeCategory: false },
];

export const seedCategoryWindowBudgets: CategoryWindowBudget[] = [
  { id: "b-groceries", categoryId: "cat-groceries", amount: 150, effectiveFrom: "2025-01-01" },
  { id: "b-utilities", categoryId: "cat-utilities", amount: 50, effectiveFrom: "2025-01-01" },
  { id: "b-fun", categoryId: "cat-fun", amount: 40, effectiveFrom: "2025-01-01" },
];

export const seedBills: Bill[] = [
  { id: "bill-rent", name: "Rent", amount: 700, dueDate: "2026-01-05", paidStatus: true, type: "bill" },
  { id: "bill-internet", name: "Internet", amount: 60, dueDate: "2026-01-12", paidStatus: false, type: "bill" },
  { id: "bill-netflix", name: "Netflix", amount: 15.49, dueDate: "2026-01-18", paidStatus: false, type: "subscription" },
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

export const seedTransactions: Transaction[] = [
  {
    id: "txn-1",
    accountId: "acct-checking",
    postedDate: "2026-01-06",
    pending: false,
    amount: 45,
    description: "Grocery Mart",
    categoryId: "cat-groceries",
    isTransfer: false,
  },
  {
    id: "txn-2",
    accountId: "acct-checking",
    postedDate: "2026-01-10",
    pending: false,
    amount: 30,
    description: "Corner Grocer",
    categoryId: "cat-groceries",
    isTransfer: false,
  },
  {
    id: "txn-3",
    accountId: "acct-checking",
    postedDate: "2026-01-09",
    pending: true,
    amount: 50,
    description: "Electric Co.",
    categoryId: "cat-utilities",
    isTransfer: false,
  },
];
