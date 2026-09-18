// Manual/on-demand sync trigger for one Item. Uses the exact same
// runPlaidTransactionsSync orchestration as the initial sync
// (exchange-public-token) and the webhook-driven sync — one code path.
//
// The access token is read only inside getPlaidItemAccessToken and
// handed directly to createPlaidFetchPage; it's never assigned to a
// variable in this route file and never appears in the response.

import { NextRequest, NextResponse } from "next/server";
import { sanitizePlaidError } from "@/lib/plaid/errors";
import { createPlaidFetchPage } from "@/lib/plaid/syncAdapters";
import { runPlaidTransactionsSync } from "@/lib/plaid/syncOrchestration";
import {
  getItemByPlaidItemId,
  getPlaidItemAccessToken,
  loadAccountIdByPlaidAccountId,
  loadMerchantRules,
  loadUserTransactions,
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

    const { syncResult, newCursor } = await runPlaidTransactionsSync({
      fetchPage: createPlaidFetchPage(await getPlaidItemAccessToken(item.id)),
      startingCursor: item.transactionsCursor ?? "",
      localTransactions,
      accountIdByPlaidAccountId,
      merchantRules,
      persistTransactions: (transactions) => persistTransactions(userId, transactions),
    });

    // Cursor only ever gets written here, after persistTransactions
    // above has already resolved successfully.
    await updateItemCursor(item.id, newCursor);

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
