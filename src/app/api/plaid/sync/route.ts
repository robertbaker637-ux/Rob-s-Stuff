// Manual/on-demand sync trigger for one Item. Uses the exact same
// runPlaidTransactionsSync orchestration as the initial sync
// (exchange-public-token) and the webhook-driven sync — one code path.
//
// The access token is read only inside getPlaidItemAccessToken and
// handed directly to createPlaidFetchPage; it's never assigned to a
// variable in this route file and never appears in the response.

import { NextRequest, NextResponse } from "next/server";
import { sanitizePlaidError } from "@/lib/plaid/errors";
import { createPlaidFetchPage, fetchAccountBalanceObservation, resolveReconciliationTimezone } from "@/lib/plaid/syncAdapters";
import { runAccountBalanceReconciliation, runPlaidTransactionsSync } from "@/lib/plaid/syncOrchestration";
import {
  getItemByPlaidItemId,
  getLatestAccountBalanceSnapshot,
  getPlaidItemAccessToken,
  loadAccountIdByPlaidAccountId,
  loadMerchantRules,
  loadTransactionsForAccount,
  loadUserAccounts,
  loadUserTransactions,
  persistReconciliationEvent,
  persistTransactions,
  updateItemCursor,
} from "@/lib/plaid/persistence";

export async function POST(request: NextRequest) {
  const { plaidItemId, userId } = await request.json();
  if (!plaidItemId || !userId) {
    return NextResponse.json({ error: "plaidItemId and userId are required" }, { status: 400 });
  }

  const item = await getItemByPlaidItemId(plaidItemId);
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  try {
    const [localTransactions, accountIdByPlaidAccountId, merchantRules] = await Promise.all([
      loadUserTransactions(userId),
      loadAccountIdByPlaidAccountId(userId),
      loadMerchantRules(userId),
    ]);

    const accessToken = await getPlaidItemAccessToken(item.id);

    const { syncResult, newCursor } = await runPlaidTransactionsSync({
      fetchPage: createPlaidFetchPage(accessToken),
      startingCursor: item.transactionsCursor ?? "",
      localTransactions,
      accountIdByPlaidAccountId,
      merchantRules,
      persistTransactions: (transactions) => persistTransactions(userId, transactions),
    });

    // Cursor only ever gets written here, after persistTransactions
    // above has already resolved successfully.
    await updateItemCursor(item.id, newCursor);

    // Balance reconciliation runs after the transaction sync is fully
    // persisted and the cursor advanced — see the canonical-order note
    // in syncOrchestration.ts's FetchBalanceObservation doc comment.
    await runAccountBalanceReconciliation({
      accounts: await loadUserAccounts(userId),
      fetchBalances: () => fetchAccountBalanceObservation(accessToken),
      syncCursor: newCursor,
      getLatestSnapshot: getLatestAccountBalanceSnapshot,
      loadTransactionsForAccount: (accountId) => loadTransactionsForAccount(userId, accountId),
      persistReconciliationEvent,
      timezone: resolveReconciliationTimezone(),
    });

    return NextResponse.json({
      created: syncResult.created,
      updated: syncResult.updated,
      reconciledPendingToPosted: syncResult.reconciledPendingToPosted,
      removed: syncResult.removed,
    });
  } catch (err) {
    const sanitized = sanitizePlaidError(err);
    console.error(`Plaid sync failed for item ${item.id}:`, sanitized);
    return NextResponse.json({ error: sanitized.message }, { status: 502 });
  }
}
