// Supabase persistence for Plaid data (rv2.4), via the service-role
// client. This is the only place plaid_items.access_token is read from
// storage — and it's returned from getPlaidItemWithAccessToken only for
// the caller to hand directly to createPlaidFetchPage; nothing here logs
// it or includes it in any function's return value beyond that one.

import { createServiceRoleClient } from "@/lib/supabase/serviceRole";
import type { Account, Debt, MerchantRule, PlaidItem, Transaction } from "@/lib/domain/types";

function toTransactionRow(userId: string, t: Transaction) {
  return {
    id: t.id,
    user_id: userId,
    account_id: t.accountId,
    posted_date: t.postedDate,
    pending: t.pending,
    amount: t.amount,
    description: t.description,
    category_id: t.categoryId ?? null,
    is_transfer: t.isTransfer,
    raw_description: t.rawDescription,
    raw_merchant_name: t.rawMerchantName ?? null,
    raw_category: t.rawCategory ?? null,
    raw_amount: t.rawAmount,
    raw_date: t.rawDate,
    normalized_merchant_name: t.normalizedMerchantName ?? null,
    needs_review: t.needsReview,
    bill_id: t.billId ?? null,
    transfer_link_id: t.transferLinkId ?? null,
    plaid_transaction_id: t.plaidTransactionId ?? null,
    plaid_pending_transaction_id: t.plaidPendingTransactionId ?? null,
  };
}

export async function persistTransactions(userId: string, transactions: Transaction[]): Promise<void> {
  if (transactions.length === 0) return;
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("transactions")
    .upsert(transactions.map((t) => toTransactionRow(userId, t)));
  if (error) throw new Error(`Failed to persist transactions: ${error.message}`);
}

function toAccountRow(userId: string, a: Account) {
  return {
    id: a.id,
    user_id: userId,
    name: a.name,
    role: a.role,
    is_manual: a.isManual,
    plaid_account_id: a.plaidAccountId ?? null,
    plaid_item_id: a.plaidItemId ?? null,
  };
}

export async function persistAccounts(userId: string, accounts: Account[]): Promise<void> {
  if (accounts.length === 0) return;
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("accounts").upsert(accounts.map((a) => toAccountRow(userId, a)));
  if (error) throw new Error(`Failed to persist accounts: ${error.message}`);
}

function toDebtRow(userId: string, d: Debt) {
  return {
    id: d.id,
    user_id: userId,
    name: d.name,
    balance: d.balance,
    apr: d.apr ?? null,
    minimum_payment: d.minimumPayment ?? null,
    plaid_account_id: d.plaidAccountId ?? null,
    liability_type: d.liabilityType ?? null,
    next_payment_due_date: d.nextPaymentDueDate ?? null,
    is_overdue: d.isOverdue ?? null,
    raw_liability_details: d.rawLiabilityDetails ?? null,
  };
}

export async function persistDebts(userId: string, debts: Debt[]): Promise<void> {
  if (debts.length === 0) return;
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("debts").upsert(debts.map((d) => toDebtRow(userId, d)));
  if (error) throw new Error(`Failed to persist debts: ${error.message}`);
}

const ITEM_COLUMNS =
  "id, user_id, plaid_item_id, institution_name, status, error_code, transactions_cursor, last_successful_sync_at, historical_pull_complete";

function fromItemRow(row: Record<string, unknown>): PlaidItem {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    plaidItemId: row.plaid_item_id as string,
    institutionName: (row.institution_name as string) ?? undefined,
    status: row.status as PlaidItem["status"],
    errorCode: (row.error_code as string) ?? undefined,
    transactionsCursor: (row.transactions_cursor as string) ?? undefined,
    lastSuccessfulSyncAt: (row.last_successful_sync_at as string) ?? undefined,
    historicalPullComplete: Boolean(row.historical_pull_complete),
  };
}

/** Creates the plaid_items row for a newly-exchanged Item. Returns the
 * PlaidItem (no access_token) for the caller's use; the access token
 * itself is written to storage but not returned from here — callers
 * that just exchanged the public token already hold it directly. */
export async function insertPlaidItem(
  userId: string,
  plaidItemId: string,
  accessToken: string,
  institutionName?: string
): Promise<PlaidItem> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("plaid_items")
    .insert({
      user_id: userId,
      plaid_item_id: plaidItemId,
      access_token: accessToken,
      institution_name: institutionName ?? null,
      status: "active",
    })
    .select(ITEM_COLUMNS)
    .single();

  if (error || !data) throw new Error(`Failed to save linked account: ${error?.message}`);
  return fromItemRow(data);
}

export async function getItemByPlaidItemId(plaidItemId: string): Promise<PlaidItem | undefined> {
  const supabase = createServiceRoleClient();
  const { data } = await supabase
    .from("plaid_items")
    .select(ITEM_COLUMNS)
    .eq("plaid_item_id", plaidItemId)
    .maybeSingle();
  return data ? fromItemRow(data) : undefined;
}

/** Only this function reads the access_token back out of storage, and
 * only for the immediate purpose of building a FetchSyncPage — it is
 * never logged or returned onward from any caller of this function. */
export async function getPlaidItemAccessToken(plaidItemDbId: string): Promise<string> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("plaid_items")
    .select("access_token")
    .eq("id", plaidItemDbId)
    .single();
  if (error || !data) throw new Error("Could not load Item credentials.");
  return data.access_token as string;
}

export async function updateItemCursor(plaidItemDbId: string, newCursor: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("plaid_items")
    .update({ transactions_cursor: newCursor, last_successful_sync_at: new Date().toISOString() })
    .eq("id", plaidItemDbId);
  if (error) throw new Error(`Failed to update sync cursor: ${error.message}`);
}

export async function markHistoricalPullComplete(plaidItemDbId: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const { error } = await supabase
    .from("plaid_items")
    .update({ historical_pull_complete: true })
    .eq("id", plaidItemDbId);
  if (error) throw new Error(`Failed to update historical pull status: ${error.message}`);
}

function fromTransactionRow(row: Record<string, unknown>): Transaction {
  return {
    id: row.id as string,
    accountId: row.account_id as string,
    postedDate: row.posted_date as string,
    pending: Boolean(row.pending),
    amount: row.amount as number,
    description: row.description as string,
    categoryId: (row.category_id as string) ?? undefined,
    isTransfer: Boolean(row.is_transfer),
    rawDescription: row.raw_description as string,
    rawMerchantName: (row.raw_merchant_name as string) ?? undefined,
    rawCategory: (row.raw_category as string) ?? undefined,
    rawAmount: row.raw_amount as number,
    rawDate: row.raw_date as string,
    normalizedMerchantName: (row.normalized_merchant_name as string) ?? undefined,
    needsReview: Boolean(row.needs_review),
    billId: (row.bill_id as string) ?? undefined,
    transferLinkId: (row.transfer_link_id as string) ?? undefined,
    plaidTransactionId: (row.plaid_transaction_id as string) ?? undefined,
    plaidPendingTransactionId: (row.plaid_pending_transaction_id as string) ?? undefined,
  };
}

export async function loadUserTransactions(userId: string): Promise<Transaction[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase.from("transactions").select("*").eq("user_id", userId);
  if (error) throw new Error(`Failed to load transactions: ${error.message}`);
  return (data ?? []).map(fromTransactionRow);
}

export async function loadAccountIdByPlaidAccountId(userId: string): Promise<Map<string, string>> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("accounts")
    .select("id, plaid_account_id")
    .eq("user_id", userId)
    .not("plaid_account_id", "is", null);
  if (error) throw new Error(`Failed to load accounts: ${error.message}`);
  return new Map((data ?? []).map((row) => [row.plaid_account_id as string, row.id as string]));
}

export async function loadMerchantRules(userId: string): Promise<MerchantRule[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("merchant_rules")
    .select("id, merchant_key, category_id")
    .eq("user_id", userId);
  if (error) throw new Error(`Failed to load merchant rules: ${error.message}`);
  return (data ?? []).map((row) => ({
    id: row.id as string,
    merchantKey: row.merchant_key as string,
    categoryId: row.category_id as string,
  }));
}

export async function applyItemErrorStatus(plaidItemDbId: string, errorCode: string): Promise<void> {
  const supabase = createServiceRoleClient();
  const status = errorCode === "ITEM_LOGIN_REQUIRED" ? "login_required" : "error";
  const { error } = await supabase
    .from("plaid_items")
    .update({ status, error_code: errorCode })
    .eq("id", plaidItemDbId);
  if (error) throw new Error(`Failed to update item error status: ${error.message}`);
}
