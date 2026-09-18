// Merchant normalization + memory (rv2.3, Step 4).
//
// A transaction's merchant identity for rule matching always comes from
// its stable RAW fields — rawMerchantName if present, else
// rawDescription. normalizedMerchantName is display output only, never
// an input to key derivation, so renaming/cleaning up how a merchant
// shows up on screen can never silently change which rule applies or
// merge/split merchant identities.

import type { MerchantRule, Transaction } from "./types";

export function normalizeMerchantKey(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, " ");
}

/** The merchant key a transaction matches rules by — always derived from
 * raw source fields, never from normalizedMerchantName. */
export function getTransactionMerchantKey(transaction: Transaction): string {
  return normalizeMerchantKey(transaction.rawMerchantName ?? transaction.rawDescription);
}

function findRule(merchantRules: MerchantRule[], merchantKey: string): MerchantRule | undefined {
  return merchantRules.find((r) => r.merchantKey === merchantKey);
}

/**
 * Applies merchant memory to a transaction: if a rule exists for its
 * raw-derived merchant key, sets categoryId + normalizedMerchantName and
 * clears needsReview; otherwise flags it needsReview for the user.
 * Raw fields are never touched.
 */
export function applyMerchantMemory(
  transaction: Transaction,
  merchantRules: MerchantRule[]
): Transaction {
  const merchantKey = getTransactionMerchantKey(transaction);
  const rule = findRule(merchantRules, merchantKey);

  if (!rule) {
    return { ...transaction, needsReview: true };
  }

  return {
    ...transaction,
    categoryId: rule.categoryId,
    normalizedMerchantName: transaction.normalizedMerchantName ?? transaction.rawMerchantName ?? transaction.rawDescription,
    needsReview: false,
  };
}

/**
 * A user correcting one transaction's category. Updates only this
 * transaction, and upserts the ONE MerchantRule for this merchant's
 * raw-derived key — re-teaching is per-merchant, never a retroactive
 * rewrite of other transactions or other merchants' rules.
 */
export function correctTransactionCategory(
  transaction: Transaction,
  newCategoryId: string,
  merchantRules: MerchantRule[]
): { transaction: Transaction; merchantRules: MerchantRule[] } {
  const merchantKey = getTransactionMerchantKey(transaction);
  const existingRule = findRule(merchantRules, merchantKey);

  const updatedTransaction: Transaction = {
    ...transaction,
    categoryId: newCategoryId,
    normalizedMerchantName: transaction.normalizedMerchantName ?? transaction.rawMerchantName ?? transaction.rawDescription,
    needsReview: false,
  };

  const updatedRule: MerchantRule = existingRule
    ? { ...existingRule, categoryId: newCategoryId }
    : { id: `rule-${merchantKey}`, merchantKey, categoryId: newCategoryId };

  const updatedRules = existingRule
    ? merchantRules.map((r) => (r.id === existingRule.id ? updatedRule : r))
    : [...merchantRules, updatedRule];

  return { transaction: updatedTransaction, merchantRules: updatedRules };
}
