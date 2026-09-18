// In-memory Repository implementation backed by the seed fixture.
// Swap this for a Supabase-backed implementation once a live project
// exists — nothing in the UI layer needs to change to do that.

import type { Repository } from "./repository";
import {
  seedAccounts,
  seedBills,
  seedCategories,
  seedCategoryWindowBudgets,
  seedDebts,
  seedIncomeSources,
  seedMerchantRules,
  seedPaySchedules,
  seedPaychecks,
  seedSinkingFunds,
  seedTransactionSplits,
  seedTransactions,
  seedTransferPairHistory,
} from "./seed";

export const seedRepository: Repository = {
  async getAccounts() {
    return seedAccounts;
  },
  async getIncomeSources() {
    return seedIncomeSources;
  },
  async getPaySchedules() {
    return seedPaySchedules;
  },
  async getCanonicalPaySchedule() {
    const primarySources = seedIncomeSources.filter((s) => s.isPrimaryWindowSource);
    if (primarySources.length !== 1) {
      throw new Error(
        `Expected exactly one primary window source, found ${primarySources.length}.`
      );
    }
    const schedule = seedPaySchedules.find(
      (s) => s.incomeSourceId === primarySources[0].id
    );
    if (!schedule) {
      throw new Error("Primary window source has no pay_schedule.");
    }
    return schedule;
  },
  async getPaychecks() {
    return seedPaychecks;
  },
  async getCategories() {
    return seedCategories;
  },
  async getCategoryWindowBudgets() {
    return seedCategoryWindowBudgets;
  },
  async getBills() {
    return seedBills;
  },
  async getSinkingFunds() {
    return seedSinkingFunds;
  },
  async getDebts() {
    return seedDebts;
  },
  async getTransactions() {
    return seedTransactions;
  },
  async getTransactionSplits() {
    return seedTransactionSplits;
  },
  async getMerchantRules() {
    return seedMerchantRules;
  },
  async getTransferPairHistory() {
    return seedTransferPairHistory;
  },
};
