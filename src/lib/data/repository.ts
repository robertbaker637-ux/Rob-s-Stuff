// Data-access interface (rv2.1).
//
// The UI shell reads through this interface, not from seed data or
// Supabase directly, so a real Supabase-backed implementation can replace
// `seedRepository` later without any page/component changes. Every method
// is async even though the seed implementation resolves synchronously,
// since a real implementation will be a network call.

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

export interface Repository {
  getAccounts(): Promise<Account[]>;
  getIncomeSources(): Promise<IncomeSource[]>;
  getPaySchedules(): Promise<PaySchedule[]>;
  /** The pay_schedule belonging to the household's designated primary
   * (canonical) income source. Throws if none or more than one is set —
   * exactly one is required before canonical-window calculations can run. */
  getCanonicalPaySchedule(): Promise<PaySchedule>;
  getPaychecks(): Promise<Paycheck[]>;
  getCategories(): Promise<Category[]>;
  getCategoryWindowBudgets(): Promise<CategoryWindowBudget[]>;
  getBills(): Promise<Bill[]>;
  getSinkingFunds(): Promise<SinkingFund[]>;
  getDebts(): Promise<Debt[]>;
  getTransactions(): Promise<Transaction[]>;
  getTransactionSplits(): Promise<TransactionSplit[]>;
  getMerchantRules(): Promise<MerchantRule[]>;
  getTransferPairHistory(): Promise<TransferPairHistory[]>;
}
