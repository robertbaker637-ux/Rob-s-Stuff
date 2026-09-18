import { describe, expect, it, vi } from "vitest";
import {
  fetchCompletePlaidSyncBatch,
  runPlaidTransactionsSync,
  type PlaidSyncPage,
} from "@/lib/plaid/syncOrchestration";
import { createLocalTransactionFromPlaid, syncPlaidTransactions } from "@/lib/domain/plaidSync";
import type { PlaidTransactionData } from "@/lib/domain/types";

const accountMap = new Map([["plaid-acct-checking", "acct-checking"]]);

function plaidTxn(overrides: Partial<PlaidTransactionData> = {}): PlaidTransactionData {
  return {
    transactionId: "plaid-txn-1",
    plaidAccountId: "plaid-acct-checking",
    amount: 45,
    date: "2026-01-06",
    pending: false,
    name: "GROCERY MART #4471",
    merchantName: "Grocery Mart",
    ...overrides,
  };
}

describe("fetchCompletePlaidSyncBatch — cross-page aggregation before reconciliation", () => {
  it("a pending removed entry on page 1 and its posted added replacement on page 2 reconcile to ONE local transaction", async () => {
    const fetchPage = vi
      .fn<(cursor: string) => Promise<PlaidSyncPage>>()
      .mockImplementationOnce(async () => ({
        added: [],
        modified: [],
        removed: [{ transactionId: "pending-1" }],
        nextCursor: "c1",
        hasMore: true,
      }))
      .mockImplementationOnce(async () => ({
        added: [plaidTxn({ transactionId: "posted-1", pendingTransactionId: "pending-1", pending: false })],
        modified: [],
        removed: [],
        nextCursor: "c2",
        hasMore: false,
      }));

    const { batch, finalCursor } = await fetchCompletePlaidSyncBatch(fetchPage, "c0");
    expect(finalCursor).toBe("c2");
    expect(batch.removed).toEqual([{ transactionId: "pending-1" }]);
    expect(batch.added).toHaveLength(1);

    const existingLocal = [
      createLocalTransactionFromPlaid(plaidTxn({ transactionId: "pending-1", pending: true }), "acct-checking", []),
    ];
    const result = syncPlaidTransactions(existingLocal, batch, accountMap, []);

    expect(result.transactions).toHaveLength(1);
    expect(result.reconciledPendingToPosted).toBe(1);
    expect(result.removed).toBe(0);
    expect(result.transactions[0].plaidTransactionId).toBe("posted-1");
  });
});

describe("runPlaidTransactionsSync — cursor is never advanced on a failed persist", () => {
  it("rejects, and a caller-side cursor variable is never reassigned", async () => {
    const fetchPage = vi
      .fn<(cursor: string) => Promise<PlaidSyncPage>>()
      .mockResolvedValue({ added: [], modified: [], removed: [], nextCursor: "c1", hasMore: false });
    const persistTransactions = vi.fn().mockRejectedValue(new Error("db write failed"));

    let storedCursor = "c0"; // mirrors how the route handler would hold plaid_items.transactions_cursor

    await expect(
      (async () => {
        const { newCursor } = await runPlaidTransactionsSync({
          fetchPage,
          startingCursor: storedCursor,
          localTransactions: [],
          accountIdByPlaidAccountId: accountMap,
          merchantRules: [],
          persistTransactions,
        });
        storedCursor = newCursor; // only reachable on success
      })()
    ).rejects.toThrow("db write failed");

    expect(storedCursor).toBe("c0");
  });
});

describe("fetchCompletePlaidSyncBatch — mutation-during-pagination restart", () => {
  it("restarts from the ORIGINAL starting cursor and does not apply the discarded first attempt's data twice", async () => {
    const fetchPage = vi
      .fn<(cursor: string) => Promise<PlaidSyncPage>>()
      .mockImplementationOnce(async () => ({
        added: [plaidTxn({ transactionId: "a" })],
        modified: [],
        removed: [],
        nextCursor: "c1",
        hasMore: true,
      }))
      .mockImplementationOnce(async () => {
        throw { error_code: "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" };
      })
      .mockImplementationOnce(async () => ({
        added: [plaidTxn({ transactionId: "a" }), plaidTxn({ transactionId: "b" })],
        modified: [],
        removed: [],
        nextCursor: "c-final",
        hasMore: false,
      }));

    const { batch, finalCursor } = await fetchCompletePlaidSyncBatch(fetchPage, "c0");

    expect(fetchPage).toHaveBeenNthCalledWith(1, "c0");
    expect(fetchPage).toHaveBeenNthCalledWith(2, "c1");
    expect(fetchPage).toHaveBeenNthCalledWith(3, "c0"); // restarted from the ORIGINAL cursor, not "c1"
    expect(fetchPage).toHaveBeenCalledTimes(3);

    expect(batch.added.map((t) => t.transactionId)).toEqual(["a", "b"]); // exactly once each
    expect(finalCursor).toBe("c-final");
  });
});
