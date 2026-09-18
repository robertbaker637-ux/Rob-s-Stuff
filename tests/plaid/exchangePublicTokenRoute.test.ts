// Route-level regression test for /api/plaid/exchange-public-token
// (rv2.6 post-implementation-audit fix).
//
// The audit found that this route captured its Step-6 balance
// observation BEFORE running the initial historical transaction sync,
// so every historical transaction ended up with firstPostedAt AFTER the
// baseline snapshot's own asOfTimestamp — the opposite of what the
// reconciliation baseline/epoch mechanism requires. That bug lived
// entirely in cross-function CALL ORDER, which no prior test exercised:
// every existing test called runAccountBalanceReconciliation/
// runPlaidTransactionsSync directly, in isolation, with hand-supplied
// timestamps. This test instead drives the REAL route handler, mocking
// only the two actual I/O boundaries (the Plaid SDK client and
// persistence.ts's Supabase calls) — createPlaidFetchPage,
// fetchAccountBalanceObservation, syncPlaidAccounts,
// syncPlaidTransactions, runPlaidTransactionsSync, and
// runAccountBalanceReconciliation all run for real.

import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { ReconciliationEvent } from "@/lib/plaid/syncOrchestration";
import type { PlaidItem, Transaction } from "@/lib/domain/types";

vi.mock("@/lib/plaid/client", () => ({
  plaidClient: {
    itemPublicTokenExchange: vi.fn(),
    accountsBalanceGet: vi.fn(),
    liabilitiesGet: vi.fn(),
    transactionsSync: vi.fn(),
  },
}));

vi.mock("@/lib/plaid/persistence", () => ({
  insertPlaidItem: vi.fn(),
  loadMerchantRules: vi.fn(),
  persistAccounts: vi.fn(),
  persistDebts: vi.fn(),
  persistTransactions: vi.fn(),
  updateItemCursor: vi.fn(),
  getLatestAccountBalanceSnapshot: vi.fn(),
  loadTransactionsForAccount: vi.fn(),
  persistReconciliationEvent: vi.fn(),
}));

const { POST } = await import("@/app/api/plaid/exchange-public-token/route");
const { plaidClient } = await import("@/lib/plaid/client");
const persistence = await import("@/lib/plaid/persistence");
const { runAccountBalanceReconciliation } = await import("@/lib/plaid/syncOrchestration");

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/plaid/exchange-public-token", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const PLAID_ACCOUNT_ID = "plaid-acct-1";
const SETUP_BALANCE = 1000; // returned by the early, account-setup accountsBalanceGet call
const RECONCILIATION_BALANCE = 957.5; // returned by the later, post-sync fetchAccountBalanceObservation call

function accountsPayload(current: number) {
  return {
    data: {
      accounts: [
        {
          account_id: PLAID_ACCOUNT_ID,
          name: "Checking",
          type: "depository",
          subtype: "checking",
          balances: { current, available: current, iso_currency_code: "USD" },
        },
      ],
    },
  };
}

describe("POST /api/plaid/exchange-public-token — canonical balance-observation ordering (rv2.6 audit fix)", () => {
  it("fetches the reconciliation balance AFTER the initial transaction sync, and never reuses the setup fetch", async () => {
    const callOrder: string[] = [];

    const item: PlaidItem = { id: "item-db-1", userId: "user-1", plaidItemId: "item-1", status: "active" };

    vi.mocked(plaidClient.itemPublicTokenExchange).mockResolvedValue({
      data: { access_token: "access-token-1", item_id: "item-1" },
    } as never);

    vi.mocked(plaidClient.accountsBalanceGet)
      .mockImplementationOnce(async () => {
        callOrder.push("accountsBalanceGet:setup");
        return accountsPayload(SETUP_BALANCE) as never;
      })
      .mockImplementationOnce(async () => {
        callOrder.push("accountsBalanceGet:reconciliation");
        return accountsPayload(RECONCILIATION_BALANCE) as never;
      });

    vi.mocked(plaidClient.liabilitiesGet).mockResolvedValue({
      data: { accounts: [], liabilities: {} },
    } as never);

    vi.mocked(plaidClient.transactionsSync).mockImplementationOnce(async () => {
      callOrder.push("transactionsSync");
      return {
        data: {
          added: [
            {
              transaction_id: "txn-hist-1",
              account_id: PLAID_ACCOUNT_ID,
              amount: 42.5,
              date: "2024-01-15", // ~2 years of Plaid history — old, but must still count as post-baseline via firstPostedAt, never pre-baseline via postedDate
              pending: false,
              name: "COFFEE SHOP",
              merchant_name: "Coffee Shop",
              category: ["Food and Drink"],
            },
          ],
          modified: [],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
        },
      } as never;
    });

    vi.mocked(persistence.insertPlaidItem).mockResolvedValue(item);
    vi.mocked(persistence.loadMerchantRules).mockResolvedValue([]);
    vi.mocked(persistence.persistAccounts).mockResolvedValue(undefined);
    vi.mocked(persistence.persistDebts).mockResolvedValue(undefined);
    vi.mocked(persistence.getLatestAccountBalanceSnapshot).mockResolvedValue(undefined); // no prior snapshot -> baseline
    vi.mocked(persistence.loadTransactionsForAccount).mockResolvedValue([]);

    vi.mocked(persistence.persistTransactions).mockImplementation(async () => {
      callOrder.push("persistTransactions");
    });
    vi.mocked(persistence.updateItemCursor).mockImplementation(async () => {
      callOrder.push("updateItemCursor");
    });
    vi.mocked(persistence.persistReconciliationEvent).mockImplementation(async () => {
      callOrder.push("persistReconciliationEvent");
    });

    const response = await POST(makeRequest({ publicToken: "public-token-1", userId: "user-1" }));
    expect(response.status).toBe(200);

    // (1) & (2) & the explicit call-order assertion: the setup balance
    // fetch may precede the sync; the RECONCILIATION balance fetch must
    // follow persistTransactions and updateItemCursor — not the reverse.
    expect(callOrder).toEqual([
      "accountsBalanceGet:setup",
      "transactionsSync",
      "persistTransactions",
      "updateItemCursor",
      "accountsBalanceGet:reconciliation",
      "persistReconciliationEvent",
    ]);

    // (6) the early setup response must never reach reconciliation.
    expect(persistence.persistReconciliationEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(persistence.persistReconciliationEvent).mock.calls[0][0] as ReconciliationEvent;
    expect(event.snapshot.asOfBalance).toBe(RECONCILIATION_BALANCE);
    expect(event.snapshot.asOfBalance).not.toBe(SETUP_BALANCE);

    // (4) the baseline (no prior snapshot) creates no offset.
    expect(event.offset).toBeUndefined();

    // (3) the historical transaction's firstPostedAt is at-or-before the
    // reconciliation observation's own timestamp (== the baseline
    // snapshot's asOfTimestamp) — the exact condition that keeps it
    // correctly excluded from all future ledger math.
    expect(persistence.persistTransactions).toHaveBeenCalledTimes(1);
    const persistedTransactions = vi.mocked(persistence.persistTransactions).mock.calls[0][1] as Transaction[];
    const historical = persistedTransactions.find((t) => t.plaidTransactionId === "txn-hist-1");
    expect(historical).toBeDefined();
    expect(historical!.firstPostedAt).toBeDefined();
    expect(historical!.firstPostedAt! <= event.snapshot.asOfTimestamp).toBe(true);

    // (5) a SECOND, later reconciliation with no new activity (same
    // confirmed balance, the historical transaction now carrying its
    // REAL persisted firstPostedAt from above) must not roll that
    // transaction forward again and must not produce a large synthetic
    // offset. This calls the REAL runAccountBalanceReconciliation /
    // reconcileAccountBalance — not a hand-rolled reimplementation —
    // against the actual data persisted by the route call above.
    const secondPersist = vi.fn<(event: ReconciliationEvent) => Promise<void>>(async () => undefined);
    const secondResult = await runAccountBalanceReconciliation({
      accounts: [
        { id: historical!.accountId, name: "Checking", role: "primary_pay", isManual: false, plaidAccountId: PLAID_ACCOUNT_ID },
      ],
      fetchBalances: async () => ({
        balances: [{ plaidAccountId: PLAID_ACCOUNT_ID, currentBalance: RECONCILIATION_BALANCE }],
        observedAt: "2024-02-01T00:00:00.000Z",
      }),
      syncCursor: "cursor-2",
      getLatestSnapshot: async () => event.snapshot,
      loadTransactionsForAccount: async () => [historical!],
      persistReconciliationEvent: secondPersist,
      timezone: "America/New_York",
    });

    expect(secondResult.offsets).toHaveLength(0);
    expect(secondPersist).toHaveBeenCalledTimes(1);
    const secondEvent = secondPersist.mock.calls[0][0] as ReconciliationEvent;
    expect(secondEvent.offset).toBeUndefined();
  });
});
