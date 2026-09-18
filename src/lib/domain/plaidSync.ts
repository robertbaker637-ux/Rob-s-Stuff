// Plaid ingestion + idempotent sync (rv2.4, Step 5).
//
// This module is ADDITIVE: payWindow.ts, paycheck.ts, sweep.ts,
// categoryAllocation.ts, calendarReporting.ts, merchantMemory.ts,
// transactionSplits.ts, and transferDetection.ts are all untouched.
// Plaid feeds the existing model through new fields on Transaction/
// Account/Debt and this new module — it does not change how any
// existing function behaves.
//
// On a "modified" Plaid event, ONLY raw-side fields (rawDescription,
// rawMerchantName, rawCategory, rawAmount, rawDate, postedDate, pending)
// plus their working mirrors (amount, description, which were never
// part of the user-correctable set) are ever updated. categoryId,
// normalizedMerchantName, needsReview, and billId are never touched by
// a sync, regardless of whether they came from merchant-memory
// auto-categorization or an explicit user correction — this is what
// makes "user-corrected category survives a later sync" true without
// needing to track correction provenance separately.
//
// Sign convention: Plaid's own convention (positive = outflow, negative
// = inflow) is identical to the one transferDetection.ts already uses,
// so amounts map straight through with no conversion.

import { applyMerchantMemory } from "./merchantMemory";
import type {
  Account,
  AccountRole,
  Debt,
  MerchantRule,
  PlaidAccountData,
  PlaidItem,
  PlaidItemStatus,
  PlaidLiabilityData,
  PlaidSyncBatch,
  PlaidTransactionData,
  SyncResult,
  Transaction,
} from "./types";

/** Pure mapping from a Plaid transaction to our raw field set — no sign
 * conversion, no categorization. Extracted so both transaction creation
 * and raw-field updates share one mapping (and one thing to test). */
export function mapPlaidTransactionToRaw(plaidTxn: PlaidTransactionData) {
  return {
    rawDescription: plaidTxn.name,
    rawMerchantName: plaidTxn.merchantName,
    rawCategory: plaidTxn.category?.[0],
    rawAmount: plaidTxn.amount,
    rawDate: plaidTxn.date,
  };
}

/** A brand-new local transaction from a Plaid "added" event. Runs
 * through the unmodified applyMerchantMemory for categorization —
 * nothing here reimplements that logic.
 *
 * `batchTimestamp` (defaults to the real clock) is the one moment this
 * whole sync batch is considered to have happened at — used to set
 * firstSeenAt (always) and firstPostedAt (only if this transaction is
 * discovered already posted; see types.ts). Injectable for tests. */
export function createLocalTransactionFromPlaid(
  plaidTxn: PlaidTransactionData,
  localAccountId: string,
  merchantRules: MerchantRule[],
  batchTimestamp: string = new Date().toISOString()
): Transaction {
  const raw = mapPlaidTransactionToRaw(plaidTxn);
  const uncategorized: Transaction = {
    id: `txn-plaid-${plaidTxn.transactionId}`,
    accountId: localAccountId,
    postedDate: plaidTxn.date,
    pending: plaidTxn.pending,
    amount: plaidTxn.amount,
    description: raw.rawDescription,
    isTransfer: false,
    ...raw,
    needsReview: true,
    plaidTransactionId: plaidTxn.transactionId,
    plaidPendingTransactionId: plaidTxn.pendingTransactionId,
    firstSeenAt: batchTimestamp,
    firstPostedAt: plaidTxn.pending ? undefined : batchTimestamp,
  };
  return applyMerchantMemory(uncategorized, merchantRules);
}

/** Updates ONLY raw/posted/pending fields on an existing local
 * transaction from a Plaid "modified" event. categoryId,
 * normalizedMerchantName, needsReview, and billId are never present in
 * the returned object's changes — they come through unchanged via the
 * spread of `existing`. */
export function applyPlaidModifiedToLocal(
  existing: Transaction,
  plaidTxn: PlaidTransactionData
): Transaction {
  const raw = mapPlaidTransactionToRaw(plaidTxn);
  return {
    ...existing,
    ...raw,
    postedDate: plaidTxn.date,
    pending: plaidTxn.pending,
    amount: plaidTxn.amount,
    description: raw.rawDescription,
    plaidTransactionId: plaidTxn.transactionId,
    plaidPendingTransactionId: plaidTxn.pendingTransactionId,
  };
}

/** A pending transaction posting: same field scope as
 * applyPlaidModifiedToLocal (raw fields only), plus the identity swap
 * Plaid itself performs (a new transaction_id) and clearing `pending`.
 * Our own internal `id` — and everything keyed off it, like splits or a
 * bill link — never changes.
 *
 * `batchTimestamp` (defaults to the real clock) is when THIS sync batch
 * — the one that discovered the posting — happened. firstPostedAt is
 * set from it, exactly once: `existing.firstPostedAt ?? batchTimestamp`
 * preserves an already-set value (shouldn't happen in practice, since a
 * transaction only posts once, but keeps this idempotent regardless).
 * firstSeenAt is never touched — it survives via applyPlaidModifiedToLocal's
 * spread of `existing`, from whenever this transaction was first
 * discovered while still pending. */
export function reconcilePendingToPosted(
  existing: Transaction,
  postedPlaidTxn: PlaidTransactionData,
  batchTimestamp: string = new Date().toISOString()
): Transaction {
  return {
    ...applyPlaidModifiedToLocal(existing, postedPlaidTxn),
    pending: false,
    firstPostedAt: existing.firstPostedAt ?? batchTimestamp,
  };
}

/**
 * The idempotent merge at the heart of Plaid sync. Operates on ONE fully
 * aggregated batch (the caller — syncOrchestration.ts — is responsible
 * for collecting every page of /transactions/sync before calling this).
 *
 * Reconciliation: an `added` item whose pendingTransactionId matches an
 * existing local transaction's plaidTransactionId is a pending→posted
 * transition, applied in place via reconcilePendingToPosted — never a
 * new row, and its removed counterpart is treated as consumed rather
 * than deleted out from under the reconciliation.
 *
 * Idempotency: an `added` item whose transactionId already exists
 * locally (a replayed/duplicate sync) updates that row instead of
 * creating a second one.
 *
 * `batchTimestamp` (defaults to the real clock) is passed through to
 * every created/posted transaction in this batch — one moment for the
 * whole batch, matching "when this sync learned about it."
 */
export function syncPlaidTransactions(
  localTransactions: Transaction[],
  batch: PlaidSyncBatch,
  accountIdByPlaidAccountId: Map<string, string>,
  merchantRules: MerchantRule[],
  batchTimestamp: string = new Date().toISOString()
): SyncResult {
  const byPlaidId = new Map<string, Transaction>();
  for (const t of localTransactions) {
    if (t.plaidTransactionId) byPlaidId.set(t.plaidTransactionId, t);
  }

  const resultById = new Map<string, Transaction>();
  for (const t of localTransactions) resultById.set(t.id, t);

  let created = 0;
  let updated = 0;
  let reconciledPendingToPosted = 0;
  let removedCount = 0;
  const consumedRemovedIds = new Set<string>();

  for (const plaidTxn of batch.added) {
    const alreadyLocal = byPlaidId.get(plaidTxn.transactionId);
    if (alreadyLocal) {
      const refreshed = applyPlaidModifiedToLocal(alreadyLocal, plaidTxn);
      resultById.set(refreshed.id, refreshed);
      updated++;
      continue;
    }

    const pendingId = plaidTxn.pendingTransactionId;
    const matchedPending = pendingId ? byPlaidId.get(pendingId) : undefined;
    if (matchedPending) {
      const reconciled = reconcilePendingToPosted(matchedPending, plaidTxn, batchTimestamp);
      resultById.set(reconciled.id, reconciled);
      consumedRemovedIds.add(pendingId!);
      reconciledPendingToPosted++;
      continue;
    }

    const localAccountId = accountIdByPlaidAccountId.get(plaidTxn.plaidAccountId);
    if (!localAccountId) continue; // unmapped account — nothing to attach to
    const created_ = createLocalTransactionFromPlaid(plaidTxn, localAccountId, merchantRules, batchTimestamp);
    resultById.set(created_.id, created_);
    created++;
  }

  for (const plaidTxn of batch.modified) {
    const existing = byPlaidId.get(plaidTxn.transactionId);
    if (existing) {
      const refreshed = applyPlaidModifiedToLocal(existing, plaidTxn);
      resultById.set(refreshed.id, refreshed);
      updated++;
      continue;
    }
    const localAccountId = accountIdByPlaidAccountId.get(plaidTxn.plaidAccountId);
    if (!localAccountId) continue;
    const created_ = createLocalTransactionFromPlaid(plaidTxn, localAccountId, merchantRules, batchTimestamp);
    resultById.set(created_.id, created_);
    created++;
  }

  for (const { transactionId } of batch.removed) {
    if (consumedRemovedIds.has(transactionId)) continue; // reconciled above, not deleted
    const existing = byPlaidId.get(transactionId);
    if (existing) {
      resultById.delete(existing.id);
      removedCount++;
    }
  }

  return {
    transactions: [...resultById.values()],
    created,
    updated,
    reconciledPendingToPosted,
    removed: removedCount,
  };
}

/**
 * Conservative role inference from Plaid's account type/subtype. Credit
 * and savings/HSA map unambiguously; everything else defaults to
 * other_manual rather than guessing which account is "primary pay" —
 * that's a Setup-wizard decision the brief assigns to the user, not
 * something Plaid's type data can answer.
 */
function inferAccountRoleFromPlaid(account: PlaidAccountData): AccountRole {
  if (account.type === "credit") return "credit_card";
  if (account.type === "loan") return "loan";
  if (account.subtype === "hsa") return "hsa";
  if (account.subtype === "savings") return "savings";
  return "other_manual";
}

/** Create-or-update Account records by plaidAccountId, for Item/account
 * persistence right after Link. Separate from the transaction/liability
 * paths above — this only ever touches accounts. */
export function syncPlaidAccounts(
  localAccounts: Account[],
  plaidItemId: string,
  plaidAccounts: PlaidAccountData[]
): Account[] {
  const result = [...localAccounts];

  for (const plaidAccount of plaidAccounts) {
    const existingIndex = result.findIndex((a) => a.plaidAccountId === plaidAccount.plaidAccountId);
    if (existingIndex >= 0) {
      result[existingIndex] = { ...result[existingIndex], name: plaidAccount.name, plaidItemId };
    } else {
      result.push({
        id: `acct-plaid-${plaidAccount.plaidAccountId}`,
        name: plaidAccount.name,
        role: inferAccountRoleFromPlaid(plaidAccount),
        isManual: false,
        plaidAccountId: plaidAccount.plaidAccountId,
        plaidItemId,
      });
    }
  }

  return result;
}

type MappedDebtFields = Pick<
  Debt,
  "balance" | "apr" | "minimumPayment" | "plaidAccountId" | "liabilityType" | "nextPaymentDueDate" | "isOverdue" | "rawLiabilityDetails"
>;

/**
 * Maps one Plaid liability into this app's Debt shape, by kind:
 *  - credit_card: Debt.apr is the entry whose aprType === "purchase_apr",
 *    if any — never the first array entry, never any other APR type. No
 *    purchase APR present leaves Debt.apr undefined (never fabricated
 *    from cash/balance-transfer/penalty/promotional APRs). The complete
 *    aprs array (all four fields per entry) is preserved verbatim in
 *    rawLiabilityDetails.aprs.
 *  - mortgage: apr comes from interestRatePercentage. isOverdue is
 *    derived from pastDueAmount (> 0), staying undefined when
 *    pastDueAmount itself is undefined — never defaulted to false, since
 *    that would silently assert "not overdue" about something unknown.
 *  - student_loan: apr/minimumPayment/nextPaymentDueDate/isOverdue map
 *    directly from Plaid's own fields.
 * Missing optional Plaid fields stay undefined throughout — never
 * defaulted to 0 or invented.
 */
export function mapPlaidLiabilityToDebt(liability: PlaidLiabilityData): MappedDebtFields {
  switch (liability.kind) {
    case "credit_card": {
      const purchaseApr = liability.aprs.find((entry) => entry.aprType === "purchase_apr");
      return {
        balance: liability.currentBalance,
        apr: purchaseApr?.aprPercentage,
        minimumPayment: liability.minimumPaymentAmount,
        plaidAccountId: liability.plaidAccountId,
        liabilityType: "credit_card",
        isOverdue: liability.isOverdue,
        rawLiabilityDetails: {
          aprs: liability.aprs.map((entry) => ({
            aprType: entry.aprType,
            aprPercentage: entry.aprPercentage,
            balanceSubjectToApr: entry.balanceSubjectToApr ?? null,
            interestChargeAmount: entry.interestChargeAmount ?? null,
          })),
          lastPaymentAmount: liability.lastPaymentAmount ?? null,
          lastPaymentDate: liability.lastPaymentDate ?? null,
        },
      };
    }
    case "mortgage": {
      const isOverdue = liability.pastDueAmount !== undefined ? liability.pastDueAmount > 0 : undefined;
      return {
        balance: liability.currentBalance,
        apr: liability.interestRatePercentage,
        plaidAccountId: liability.plaidAccountId,
        liabilityType: "mortgage",
        nextPaymentDueDate: liability.nextPaymentDueDate,
        isOverdue,
      };
    }
    case "student_loan": {
      return {
        balance: liability.currentBalance,
        apr: liability.interestRatePercentage,
        minimumPayment: liability.minimumPaymentAmount,
        plaidAccountId: liability.plaidAccountId,
        liabilityType: "student_loan",
        nextPaymentDueDate: liability.nextPaymentDueDate,
        isOverdue: liability.isOverdue,
      };
    }
  }
}

/** Create-or-update Debt records by plaidAccountId — Plaid's real,
 * stable liability identity (there is no separate provider
 * liability_id). Every liability this function sees already has a
 * non-null plaidAccountId; the null-account_id case is filtered out one
 * layer up, in syncAdapters.ts's mapLiabilitiesResponseToLiabilityData.
 * Completely separate from the transaction/category path above — proven
 * by test to never touch transactions or categories. */
export function syncPlaidLiabilities(
  localDebts: Debt[],
  liabilities: PlaidLiabilityData[]
): Debt[] {
  const result = [...localDebts];

  for (const liability of liabilities) {
    const mapped = mapPlaidLiabilityToDebt(liability);
    const existingIndex = result.findIndex(
      (d) => d.plaidAccountId === liability.plaidAccountId
    );
    if (existingIndex >= 0) {
      result[existingIndex] = { ...result[existingIndex], ...mapped };
    } else {
      result.push({
        id: `debt-plaid-${liability.plaidAccountId}`,
        name: liability.accountName ?? "Linked Account",
        ...mapped,
      });
    }
  }

  return result;
}

/** Pure PlaidItem -> PlaidItem transition. Takes no accounts/transactions
 * argument at all, so it is structurally incapable of deleting or
 * otherwise touching historical data — a stale/errored connection only
 * ever changes this one record's status. */
export function applyPlaidWebhookError(item: PlaidItem, errorCode: string): PlaidItem {
  const status: PlaidItemStatus = errorCode === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error";
  return { ...item, status, errorCode };
}

export function clearPlaidItemError(item: PlaidItem): PlaidItem {
  return { ...item, status: "active", errorCode: undefined };
}
