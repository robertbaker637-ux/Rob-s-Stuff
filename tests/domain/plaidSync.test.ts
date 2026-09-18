import { describe, expect, it } from "vitest";
import {
  applyPlaidWebhookError,
  createLocalTransactionFromPlaid,
  mapPlaidTransactionToRaw,
  syncPlaidAccounts,
  syncPlaidLiabilities,
  syncPlaidTransactions,
} from "@/lib/domain/plaidSync";
import { correctTransactionCategory } from "@/lib/domain/merchantMemory";
import type {
  Account,
  Debt,
  MerchantRule,
  PlaidAccountData,
  PlaidItem,
  PlaidLiabilityData,
  PlaidSyncBatch,
  PlaidTransactionData,
  Transaction,
} from "@/lib/domain/types";

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
    category: ["Food and Drink", "Groceries"],
    ...overrides,
  };
}

describe("mapPlaidTransactionToRaw — raw field preservation", () => {
  it("maps Plaid's merchant/category/date/amount exactly, with no sign conversion", () => {
    const txn = plaidTxn({ amount: 45, date: "2026-01-06" });
    const raw = mapPlaidTransactionToRaw(txn);
    expect(raw).toEqual({
      rawDescription: "GROCERY MART #4471",
      rawMerchantName: "Grocery Mart",
      rawCategory: "Food and Drink",
      rawAmount: 45,
      rawDate: "2026-01-06",
    });
  });
});

describe("syncPlaidTransactions — repeated sync does not duplicate", () => {
  it("calling sync twice with the same added batch updates the existing row instead of creating a second one", () => {
    const batch: PlaidSyncBatch = { added: [plaidTxn()], modified: [], removed: [] };

    const first = syncPlaidTransactions([], batch, accountMap, []);
    expect(first.transactions).toHaveLength(1);
    expect(first.created).toBe(1);

    const second = syncPlaidTransactions(first.transactions, batch, accountMap, []);
    expect(second.transactions).toHaveLength(1);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    expect(second.transactions[0].id).toBe(first.transactions[0].id);
  });
});

describe("syncPlaidTransactions — pending to posted reconciliation", () => {
  it("a removed pending id plus an added posted replacement reconcile to ONE local transaction, no duplicate", () => {
    const pendingBatch: PlaidSyncBatch = {
      added: [plaidTxn({ transactionId: "pending-1", pending: true, amount: 40 })],
      modified: [],
      removed: [],
    };
    const afterPending = syncPlaidTransactions([], pendingBatch, accountMap, []);
    expect(afterPending.transactions).toHaveLength(1);
    const localId = afterPending.transactions[0].id;

    const postingBatch: PlaidSyncBatch = {
      added: [
        plaidTxn({
          transactionId: "posted-1",
          pendingTransactionId: "pending-1",
          pending: false,
          amount: 42, // settled for a slightly different amount
        }),
      ],
      modified: [],
      removed: [{ transactionId: "pending-1" }],
    };
    const afterPosting = syncPlaidTransactions(afterPending.transactions, postingBatch, accountMap, []);

    expect(afterPosting.transactions).toHaveLength(1);
    expect(afterPosting.reconciledPendingToPosted).toBe(1);
    expect(afterPosting.removed).toBe(0); // consumed by reconciliation, not a separate deletion
    expect(afterPosting.transactions[0].id).toBe(localId); // same internal row
    expect(afterPosting.transactions[0].plaidTransactionId).toBe("posted-1");
    expect(afterPosting.transactions[0].pending).toBe(false);
    expect(afterPosting.transactions[0].amount).toBe(42);
  });

  it("preserves a prior user correction across the pending-to-posted transition", () => {
    const pendingBatch: PlaidSyncBatch = {
      added: [plaidTxn({ transactionId: "pending-2", pending: true, amount: 90 })],
      modified: [],
      removed: [],
    };
    const afterPending = syncPlaidTransactions([], pendingBatch, accountMap, []);
    const { transaction: corrected, merchantRules } = correctTransactionCategory(
      afterPending.transactions[0],
      "cat-household",
      []
    );

    const postingBatch: PlaidSyncBatch = {
      added: [
        plaidTxn({ transactionId: "posted-2", pendingTransactionId: "pending-2", pending: false, amount: 90 }),
      ],
      modified: [],
      removed: [{ transactionId: "pending-2" }],
    };
    const afterPosting = syncPlaidTransactions([corrected], postingBatch, accountMap, merchantRules);

    expect(afterPosting.transactions).toHaveLength(1);
    expect(afterPosting.transactions[0].categoryId).toBe("cat-household");
  });
});

describe("syncPlaidTransactions — user-corrected category survives a later modified sync", () => {
  it("a modified event that changes raw fields never touches categoryId/normalizedMerchantName/needsReview", () => {
    const created = createLocalTransactionFromPlaid(plaidTxn(), "acct-checking", []);
    const { transaction: corrected } = correctTransactionCategory(created, "cat-groceries", []);
    expect(corrected.needsReview).toBe(false);

    const batch: PlaidSyncBatch = {
      added: [],
      modified: [
        plaidTxn({
          amount: 46.5, // raw amount changed
          date: "2026-01-07", // raw date changed
          merchantName: "Grocery Mart Corp.", // raw merchant name changed
        }),
      ],
      removed: [],
    };

    const result = syncPlaidTransactions([corrected], batch, accountMap, []);
    const updated = result.transactions[0];

    expect(updated.categoryId).toBe("cat-groceries"); // survived
    expect(updated.needsReview).toBe(false); // survived
    expect(updated.rawAmount).toBe(46.5); // raw side did update
    expect(updated.rawMerchantName).toBe("Grocery Mart Corp.");
    expect(updated.rawDate).toBe("2026-01-07");
  });
});

describe("applyPlaidWebhookError — reconnect/error state without touching historical data", () => {
  it("only returns an updated PlaidItem; it takes no accounts/transactions and so cannot delete them", () => {
    const item: PlaidItem = {
      id: "item-1",
      userId: "user-1",
      plaidItemId: "plaid-item-1",
      status: "active",
      transactionsCursor: "cursor-abc",
    };
    const localTransactions: Transaction[] = [
      createLocalTransactionFromPlaid(plaidTxn(), "acct-checking", []),
    ];
    const localTransactionsSnapshot = [...localTransactions];

    const updatedItem = applyPlaidWebhookError(item, "ITEM_LOGIN_REQUIRED");

    expect(updatedItem.status).toBe("login_required");
    expect(updatedItem.errorCode).toBe("ITEM_LOGIN_REQUIRED");
    // The cursor (and everything else about the item) is preserved.
    expect(updatedItem.transactionsCursor).toBe("cursor-abc");
    // Historical data, held entirely outside this call, is untouched —
    // proven structurally: the function signature doesn't even accept
    // transactions/accounts, so this array is exactly what it was.
    expect(localTransactions).toEqual(localTransactionsSnapshot);
  });
});

describe("syncPlaidTransactions — historical backfill", () => {
  it("ingests a large added batch against an empty local list via the same sync entry point", () => {
    const backfillBatch: PlaidSyncBatch = {
      added: Array.from({ length: 50 }, (_, i) =>
        plaidTxn({ transactionId: `backfill-${i}`, date: "2024-06-01", amount: 10 + i })
      ),
      modified: [],
      removed: [],
    };

    const result = syncPlaidTransactions([], backfillBatch, accountMap, []);
    expect(result.created).toBe(50);
    expect(result.transactions).toHaveLength(50);
    expect(result.transactions.every((t) => t.plaidTransactionId?.startsWith("backfill-"))).toBe(true);
  });
});

describe("syncPlaidAccounts — Item/account persistence", () => {
  it("creates accounts with a conservative role inference and updates by plaidAccountId on re-sync", () => {
    const localAccounts: Account[] = [];
    const plaidAccounts: PlaidAccountData[] = [
      { plaidAccountId: "plaid-acct-checking", name: "Plaid Checking", type: "depository", subtype: "checking" },
      { plaidAccountId: "plaid-acct-savings", name: "Plaid Savings", type: "depository", subtype: "savings" },
      { plaidAccountId: "plaid-acct-cc", name: "Plaid Credit Card", type: "credit" },
    ];

    const result = syncPlaidAccounts(localAccounts, "item-1", plaidAccounts);
    expect(result).toHaveLength(3);
    expect(result.find((a) => a.plaidAccountId === "plaid-acct-checking")?.role).toBe("other_manual");
    expect(result.find((a) => a.plaidAccountId === "plaid-acct-savings")?.role).toBe("savings");
    expect(result.find((a) => a.plaidAccountId === "plaid-acct-cc")?.role).toBe("credit_card");
    expect(result.every((a) => a.plaidItemId === "item-1" && !a.isManual)).toBe(true);

    const resynced = syncPlaidAccounts(result, "item-1", [
      { plaidAccountId: "plaid-acct-checking", name: "Renamed Checking", type: "depository", subtype: "checking" },
    ]);
    expect(resynced).toHaveLength(3); // no duplicate row
    expect(resynced.find((a) => a.plaidAccountId === "plaid-acct-checking")?.name).toBe("Renamed Checking");
  });
});

describe("syncPlaidLiabilities — distinct from spending categorization", () => {
  it("creates and updates Debt records without touching any Transaction or category", () => {
    const localDebts: Debt[] = [
      { id: "debt-cc", name: "Credit Card", balance: 1200, apr: 22.99, minimumPayment: 35 },
    ];
    const localTransactions: Transaction[] = [
      createLocalTransactionFromPlaid(plaidTxn(), "acct-checking", []),
    ];
    const transactionsSnapshot = [...localTransactions];

    const liabilities: PlaidLiabilityData[] = [
      { plaidLiabilityId: "plaid-liability-1", currentBalance: 500, apr: 18.5, minimumPaymentAmount: 25, accountName: "Store Card" },
    ];

    const updatedDebts = syncPlaidLiabilities(localDebts, liabilities);

    expect(updatedDebts).toHaveLength(2);
    const newDebt = updatedDebts.find((d) => d.plaidLiabilityId === "plaid-liability-1");
    expect(newDebt).toMatchObject({ balance: 500, apr: 18.5, minimumPayment: 25, name: "Store Card" });

    // Re-sync updates the same row rather than duplicating it.
    const resynced = syncPlaidLiabilities(updatedDebts, [
      { ...liabilities[0], currentBalance: 480 },
    ]);
    expect(resynced).toHaveLength(2);
    expect(resynced.find((d) => d.plaidLiabilityId === "plaid-liability-1")?.balance).toBe(480);

    // Never touched transactions.
    expect(localTransactions).toEqual(transactionsSnapshot);
  });
});
