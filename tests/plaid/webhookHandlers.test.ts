import { describe, expect, it, vi } from "vitest";
import { routeTransactionsWebhook } from "@/lib/plaid/webhookHandlers";
import type { PlaidItem } from "@/lib/domain/types";

const item: PlaidItem = {
  id: "item-1",
  userId: "user-1",
  plaidItemId: "plaid-item-1",
  status: "active",
};

function makeDeps() {
  return {
    getItemByPlaidItemId: vi.fn().mockResolvedValue(item),
    runSync: vi.fn().mockResolvedValue(undefined),
    markHistoricalPullComplete: vi.fn().mockResolvedValue(undefined),
  };
}

describe("routeTransactionsWebhook — SYNC_UPDATES_AVAILABLE", () => {
  it("historical_update_complete: false runs sync once and does not mark historical completion", async () => {
    const deps = makeDeps();
    await routeTransactionsWebhook(
      {
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "plaid-item-1",
        initial_update_complete: true,
        historical_update_complete: false,
      },
      deps
    );

    expect(deps.runSync).toHaveBeenCalledTimes(1);
    expect(deps.runSync).toHaveBeenCalledWith(item);
    expect(deps.markHistoricalPullComplete).not.toHaveBeenCalled();
  });

  it("historical_update_complete: true runs sync once AND marks historicalPullComplete, as a side effect of that same call — never instead of syncing", async () => {
    const deps = makeDeps();
    await routeTransactionsWebhook(
      {
        webhook_type: "TRANSACTIONS",
        webhook_code: "SYNC_UPDATES_AVAILABLE",
        item_id: "plaid-item-1",
        initial_update_complete: true,
        historical_update_complete: true,
      },
      deps
    );

    expect(deps.runSync).toHaveBeenCalledTimes(1);
    expect(deps.runSync).toHaveBeenCalledWith(item);
    expect(deps.markHistoricalPullComplete).toHaveBeenCalledTimes(1);
    expect(deps.markHistoricalPullComplete).toHaveBeenCalledWith(item);
  });

  it("ignores webhook codes other than SYNC_UPDATES_AVAILABLE — there is no HISTORICAL_UPDATE_COMPLETE code to react to", async () => {
    const deps = makeDeps();
    await routeTransactionsWebhook(
      { webhook_type: "TRANSACTIONS", webhook_code: "HISTORICAL_UPDATE", item_id: "plaid-item-1" },
      deps
    );
    await routeTransactionsWebhook(
      { webhook_type: "TRANSACTIONS", webhook_code: "DEFAULT_UPDATE", item_id: "plaid-item-1" },
      deps
    );

    expect(deps.runSync).not.toHaveBeenCalled();
    expect(deps.markHistoricalPullComplete).not.toHaveBeenCalled();
  });

  it("does nothing if the item can't be found (e.g. already unlinked)", async () => {
    const deps = { ...makeDeps(), getItemByPlaidItemId: vi.fn().mockResolvedValue(undefined) };
    await routeTransactionsWebhook(
      { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "unknown-item" },
      deps
    );
    expect(deps.runSync).not.toHaveBeenCalled();
  });
});
