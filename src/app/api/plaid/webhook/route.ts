// Plaid webhook receiver (rv2.5: signature-verified).
//
// The raw request body is captured via request.text() FIRST, before any
// JSON parsing — reading it as text and JSON.parse-ing that same string
// afterward (rather than also calling request.json()) is what lets the
// SHA-256 body-hash check in verifyPlaidWebhook run against Plaid's exact
// byte sequence. Two separate reads of a Request body aren't guaranteed
// reliable, and re-serializing a parsed object would not reproduce
// Plaid's exact bytes.
//
// Verification runs BEFORE any dispatch: a missing Plaid-Verification
// header or a failed verifyPlaidWebhook call returns 401 immediately —
// no JSON.parse of the body for dispatch, no getItemByPlaidItemId, no
// routeTransactionsWebhook call, no cursor/historical-flag update. Every
// existing downstream dependency only runs after verification succeeds.
//
// Only TRANSACTIONS/SYNC_UPDATES_AVAILABLE is dispatched anywhere (via
// routeTransactionsWebhook) — every other webhook type/code is
// acknowledged and ignored this pass.
//
// Nothing here ever logs the JWT, the raw body, or key material — only
// the fixed reason string from verifyPlaidWebhook, or sanitizePlaidError
// output, is ever logged.

import { NextRequest, NextResponse } from "next/server";
import { routeTransactionsWebhook, type PlaidWebhookPayload } from "@/lib/plaid/webhookHandlers";
import { sanitizePlaidError } from "@/lib/plaid/errors";
import { createPlaidFetchPage, fetchAccountBalanceObservation, fetchPlaidJwk, resolveReconciliationTimezone } from "@/lib/plaid/syncAdapters";
import { runAccountBalanceReconciliation, runPlaidTransactionsSync } from "@/lib/plaid/syncOrchestration";
import { createJwkCache, verifyPlaidWebhook } from "@/lib/plaid/webhookVerification";
import {
  getItemByPlaidItemId,
  getLatestAccountBalanceSnapshot,
  getPlaidItemAccessToken,
  loadAccountIdByPlaidAccountId,
  loadMerchantRules,
  loadTransactionsForAccount,
  loadUserAccounts,
  loadUserTransactions,
  markHistoricalPullComplete,
  persistReconciliationEvent,
  persistTransactions,
  updateItemCursor,
} from "@/lib/plaid/persistence";
import type { PlaidItem } from "@/lib/domain/types";

// Module-scoped so the JWK cache survives across requests within the
// same server instance — created once, reused by every POST.
const jwkCache = createJwkCache(fetchPlaidJwk);

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

  await runAccountBalanceReconciliation({
    accounts: await loadUserAccounts(item.userId),
    fetchBalances: () => fetchAccountBalanceObservation(accessToken),
    syncCursor: newCursor,
    getLatestSnapshot: getLatestAccountBalanceSnapshot,
    loadTransactionsForAccount: (accountId) => loadTransactionsForAccount(item.userId, accountId),
    persistReconciliationEvent,
    timezone: resolveReconciliationTimezone(),
  });
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const jwt = request.headers.get("Plaid-Verification");
  if (!jwt) {
    console.error("Plaid webhook rejected: missing Plaid-Verification header");
    return NextResponse.json({ error: "missing_verification_header" }, { status: 401 });
  }

  const verification = await verifyPlaidWebhook({ jwt, rawBody, getJwk: jwkCache.getJwk });
  if (!verification.valid) {
    console.error("Plaid webhook rejected:", verification.reason);
    return NextResponse.json({ error: verification.reason }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as PlaidWebhookPayload;

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
