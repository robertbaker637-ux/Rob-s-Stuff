// Plaid webhook receiver. Only TRANSACTIONS/SYNC_UPDATES_AVAILABLE is
// dispatched anywhere (via routeTransactionsWebhook, the same function
// tested in tests/plaid/webhookHandlers.test.ts) — every other webhook
// type/code is acknowledged and ignored this pass.
//
// NOTE: this does not yet verify Plaid's webhook JWT signature
// (`plaid-verification-key-id` header + Plaid's public key endpoint).
// That's necessary before this route is exposed on a real deployment —
// flagged here deliberately rather than silently skipped.

import { NextRequest, NextResponse } from "next/server";
import { routeTransactionsWebhook, type PlaidWebhookPayload } from "@/lib/plaid/webhookHandlers";
import { sanitizePlaidError } from "@/lib/plaid/errors";
import { createPlaidFetchPage } from "@/lib/plaid/syncAdapters";
import { runPlaidTransactionsSync } from "@/lib/plaid/syncOrchestration";
import {
  getItemByPlaidItemId,
  getPlaidItemAccessToken,
  loadAccountIdByPlaidAccountId,
  loadMerchantRules,
  loadUserTransactions,
  markHistoricalPullComplete,
  persistTransactions,
  updateItemCursor,
} from "@/lib/plaid/persistence";
import type { PlaidItem } from "@/lib/domain/types";

async function runSyncForItem(item: PlaidItem): Promise<void> {
  const [localTransactions, accountIdByPlaidAccountId, merchantRules, accessToken] = await Promise.all([
    loadUserTransactions(item.userId),
    loadAccountIdByPlaidAccountId(item.userId),
    loadMerchantRules(item.userId),
    getPlaidItemAccessToken(item.id),
  ]);

  const { newCursor } = await runPlaidTransactionsSync({
    fetchPage: createPlaidFetchPage(accessToken),
    startingCursor: item.transactionsCursor ?? "",
    localTransactions,
    accountIdByPlaidAccountId,
    merchantRules,
    persistTransactions: (transactions) => persistTransactions(item.userId, transactions),
  });

  await updateItemCursor(item.id, newCursor);
}

export async function POST(request: NextRequest) {
  const payload = (await request.json()) as PlaidWebhookPayload;

  if (payload.webhook_type !== "TRANSACTIONS") {
    return NextResponse.json({ received: true }); // out of scope this pass
  }

  try {
    await routeTransactionsWebhook(payload, {
      getItemByPlaidItemId,
      runSync: runSyncForItem,
      markHistoricalPullComplete: (item) => markHistoricalPullComplete(item.id),
    });
    return NextResponse.json({ received: true });
  } catch (err) {
    const sanitized = sanitizePlaidError(err);
    console.error("Plaid webhook handling failed:", sanitized);
    // Plaid retries on non-2xx, so this deliberately still returns 200 —
    // a permanent failure here shouldn't cause unbounded webhook retries
    // for a personal single-item app; the next SYNC_UPDATES_AVAILABLE or
    // a manual /api/plaid/sync call will catch back up.
    return NextResponse.json({ received: true, error: sanitized.message });
  }
}
