// Plaid webhook dispatch (rv2.4).
//
// SYNC_UPDATES_AVAILABLE is the only webhook code this pass listens to —
// Plaid's recommended canonical path for /transactions/sync. The older
// HISTORICAL_UPDATE/INITIAL_UPDATE/DEFAULT_UPDATE transaction webhooks
// are ignored. There is no separate "HISTORICAL_UPDATE_COMPLETE" webhook
// code — historical-pull completion is a boolean FIELD on the
// SYNC_UPDATES_AVAILABLE payload itself, alongside initial_update_complete.
//
// On every SYNC_UPDATES_AVAILABLE event, this unconditionally triggers
// the SAME sync orchestration used everywhere else (no second
// transaction-import path). If that payload's historical_update_complete
// is true, marking the item's historicalPullComplete flag is an
// ADDITIONAL side effect of that same call — never a flag set instead of
// syncing, since the sync itself is what actually retrieves the
// remaining historical data.

import type { PlaidItem } from "@/lib/domain/types";

export interface PlaidWebhookPayload {
  webhook_type: string;
  webhook_code: string;
  item_id: string;
  initial_update_complete?: boolean;
  historical_update_complete?: boolean;
}

export interface RouteTransactionsWebhookDeps {
  getItemByPlaidItemId: (plaidItemId: string) => Promise<PlaidItem | undefined>;
  /** Stands in for running runPlaidTransactionsSync for this item (the
   * route handler binds the actual fetchPage/persistTransactions before
   * passing this in — see the /api/plaid/webhook route). */
  runSync: (item: PlaidItem) => Promise<void>;
  markHistoricalPullComplete: (item: PlaidItem) => Promise<void>;
}

export async function routeTransactionsWebhook(
  payload: PlaidWebhookPayload,
  deps: RouteTransactionsWebhookDeps
): Promise<void> {
  if (payload.webhook_code !== "SYNC_UPDATES_AVAILABLE") {
    return; // out of scope this pass
  }

  const item = await deps.getItemByPlaidItemId(payload.item_id);
  if (!item) return;

  await deps.runSync(item);

  if (payload.historical_update_complete) {
    await deps.markHistoricalPullComplete(item);
  }
}
