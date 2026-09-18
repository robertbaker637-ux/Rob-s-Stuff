import { describe, expect, it } from "vitest";
import {
  applyPlaidWebhookError,
  createLocalTransactionFromPlaid,
  mapPlaidLiabilityToDebt,
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

describe("createLocalTransactionFromPlaid — merchant rules on the initial sync (rv2.5 regression)", () => {
  it("a known merchant's rule is applied to a brand-new transaction on the very first import, not just later syncs", () => {
    // Same call shape exchange-public-token/route.ts now makes on a
    // first-ever sync: real merchant rules passed in, not [].
    const merchantRules: MerchantRule[] = [
      { id: "rule-1", merchantKey: "GROCERY MART", categoryId: "cat-groceries" },
    ];

    const created = createLocalTransactionFromPlaid(plaidTxn(), "acct-checking", merchantRules);

    expect(created.categoryId).toBe("cat-groceries");
    expect(created.needsReview).toBe(false);
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

// ============================================================================
// Liability mapping (rv2.5): credit card / mortgage / student loan
// ============================================================================

function creditCardLiability(overrides: Record<string, unknown> = {}): PlaidLiabilityData {
  return {
    kind: "credit_card",
    plaidAccountId: "plaid-acct-cc-1",
    currentBalance: 500,
    accountName: "Store Card",
    aprs: [{ aprType: "purchase_apr", aprPercentage: 18.5 }],
    ...overrides,
  } as PlaidLiabilityData;
}

function mortgageLiability(overrides: Record<string, unknown> = {}): PlaidLiabilityData {
  return {
    kind: "mortgage",
    plaidAccountId: "plaid-acct-mortgage-1",
    currentBalance: 250000,
    accountName: "Home Mortgage",
    interestRatePercentage: 6.25,
    nextPaymentDueDate: "2026-02-01",
    ...overrides,
  } as PlaidLiabilityData;
}

function studentLoanLiability(overrides: Record<string, unknown> = {}): PlaidLiabilityData {
  return {
    kind: "student_loan",
    plaidAccountId: "plaid-acct-loan-1",
    currentBalance: 15000,
    accountName: "Federal Loan",
    interestRatePercentage: 4.5,
    minimumPaymentAmount: 120,
    nextPaymentDueDate: "2026-02-15",
    ...overrides,
  } as PlaidLiabilityData;
}

describe("mapPlaidLiabilityToDebt — credit-card APR semantics", () => {
  it("selects the purchase_apr entry's percentage as Debt.apr, and preserves ALL aprs entries (with subfields) in rawLiabilityDetails", () => {
    const liability = creditCardLiability({
      aprs: [
        { aprType: "cash_apr", aprPercentage: 27.99, balanceSubjectToApr: 100, interestChargeAmount: 5 },
        { aprType: "purchase_apr", aprPercentage: 18.5, balanceSubjectToApr: 900, interestChargeAmount: 12 },
        { aprType: "penalty_apr", aprPercentage: 29.99 },
      ],
    });

    const mapped = mapPlaidLiabilityToDebt(liability);

    expect(mapped.apr).toBe(18.5);
    expect(mapped.rawLiabilityDetails?.aprs).toEqual([
      { aprType: "cash_apr", aprPercentage: 27.99, balanceSubjectToApr: 100, interestChargeAmount: 5 },
      { aprType: "purchase_apr", aprPercentage: 18.5, balanceSubjectToApr: 900, interestChargeAmount: 12 },
      { aprType: "penalty_apr", aprPercentage: 29.99, balanceSubjectToApr: null, interestChargeAmount: null },
    ]);
  });

  it("is deterministic regardless of array order — Debt.apr never depends on which entry comes first", () => {
    const first = creditCardLiability({
      aprs: [
        { aprType: "purchase_apr", aprPercentage: 18.5 },
        { aprType: "cash_apr", aprPercentage: 27.99 },
      ],
    });
    const reordered = creditCardLiability({
      aprs: [
        { aprType: "cash_apr", aprPercentage: 27.99 },
        { aprType: "purchase_apr", aprPercentage: 18.5 },
      ],
    });

    expect(mapPlaidLiabilityToDebt(first).apr).toBe(18.5);
    expect(mapPlaidLiabilityToDebt(reordered).apr).toBe(18.5);
  });

  it("no purchase_apr entry present -> Debt.apr is undefined, never fabricated from another APR type", () => {
    const liability = creditCardLiability({
      aprs: [
        { aprType: "cash_apr", aprPercentage: 27.99 },
        { aprType: "penalty_apr", aprPercentage: 29.99 },
      ],
    });

    expect(mapPlaidLiabilityToDebt(liability).apr).toBeUndefined();
  });
});

describe("mapPlaidLiabilityToDebt — mortgage", () => {
  it("maps apr from interestRatePercentage, nextPaymentDueDate direct, liabilityType mortgage", () => {
    const mapped = mapPlaidLiabilityToDebt(mortgageLiability());
    expect(mapped.apr).toBe(6.25);
    expect(mapped.nextPaymentDueDate).toBe("2026-02-01");
    expect(mapped.liabilityType).toBe("mortgage");
  });

  it("isOverdue: positive pastDueAmount -> true", () => {
    const mapped = mapPlaidLiabilityToDebt(mortgageLiability({ pastDueAmount: 250 }));
    expect(mapped.isOverdue).toBe(true);
  });

  it("isOverdue: pastDueAmount of exactly 0 -> false", () => {
    const mapped = mapPlaidLiabilityToDebt(mortgageLiability({ pastDueAmount: 0 }));
    expect(mapped.isOverdue).toBe(false);
  });

  it("isOverdue: pastDueAmount absent -> undefined, never defaulted to false", () => {
    const mapped = mapPlaidLiabilityToDebt(mortgageLiability());
    expect(mapped.isOverdue).toBeUndefined();
  });
});

describe("mapPlaidLiabilityToDebt — student loan", () => {
  it("maps apr/minimumPayment/nextPaymentDueDate, liabilityType student_loan", () => {
    const mapped = mapPlaidLiabilityToDebt(studentLoanLiability());
    expect(mapped.apr).toBe(4.5);
    expect(mapped.minimumPayment).toBe(120);
    expect(mapped.nextPaymentDueDate).toBe("2026-02-15");
    expect(mapped.liabilityType).toBe("student_loan");
  });
});

describe("mapPlaidLiabilityToDebt — missing optional fields", () => {
  it("a liability with only the required fields maps without throwing and without fabricating apr/minimumPayment/nextPaymentDueDate", () => {
    const liability: PlaidLiabilityData = {
      kind: "student_loan",
      plaidAccountId: "plaid-acct-loan-bare",
      currentBalance: 1000,
    };
    const mapped = mapPlaidLiabilityToDebt(liability);
    expect(mapped.balance).toBe(1000);
    expect(mapped.apr).toBeUndefined();
    expect(mapped.minimumPayment).toBeUndefined();
    expect(mapped.nextPaymentDueDate).toBeUndefined();
    expect(mapped.isOverdue).toBeUndefined();
  });
});

describe("syncPlaidLiabilities — create-or-update by plaidAccountId, one test per liability kind", () => {
  it("credit card: re-syncing the same plaidAccountId updates the existing Debt row rather than duplicating", () => {
    const created = syncPlaidLiabilities([], [creditCardLiability({ currentBalance: 500 })]);
    expect(created).toHaveLength(1);
    const id = created[0].id;

    const resynced = syncPlaidLiabilities(created, [creditCardLiability({ currentBalance: 480 })]);
    expect(resynced).toHaveLength(1);
    expect(resynced[0].id).toBe(id);
    expect(resynced[0].balance).toBe(480);
  });

  it("mortgage: re-syncing the same plaidAccountId updates the existing Debt row rather than duplicating", () => {
    const created = syncPlaidLiabilities([], [mortgageLiability({ currentBalance: 250000 })]);
    expect(created).toHaveLength(1);
    const id = created[0].id;

    const resynced = syncPlaidLiabilities(created, [mortgageLiability({ currentBalance: 248000 })]);
    expect(resynced).toHaveLength(1);
    expect(resynced[0].id).toBe(id);
    expect(resynced[0].balance).toBe(248000);
  });

  it("student loan: re-syncing the same plaidAccountId updates the existing Debt row rather than duplicating", () => {
    const created = syncPlaidLiabilities([], [studentLoanLiability({ currentBalance: 15000 })]);
    expect(created).toHaveLength(1);
    const id = created[0].id;

    const resynced = syncPlaidLiabilities(created, [studentLoanLiability({ currentBalance: 14500 })]);
    expect(resynced).toHaveLength(1);
    expect(resynced[0].id).toBe(id);
    expect(resynced[0].balance).toBe(14500);
  });
});

describe("syncPlaidLiabilities — distinct from spending categorization", () => {
  it("creates and updates Debt records (credit card, mortgage, and student loan) without touching any Transaction or category", () => {
    const localDebts: Debt[] = [
      { id: "debt-cc", name: "Credit Card", balance: 1200, apr: 22.99, minimumPayment: 35 },
    ];
    const localTransactions: Transaction[] = [
      createLocalTransactionFromPlaid(plaidTxn(), "acct-checking", []),
    ];
    const transactionsSnapshot = [...localTransactions];

    const liabilities: PlaidLiabilityData[] = [
      creditCardLiability(),
      mortgageLiability(),
      studentLoanLiability(),
    ];

    const updatedDebts = syncPlaidLiabilities(localDebts, liabilities);

    expect(updatedDebts).toHaveLength(4);
    const cc = updatedDebts.find((d) => d.plaidAccountId === "plaid-acct-cc-1");
    expect(cc).toMatchObject({ balance: 500, apr: 18.5, name: "Store Card", liabilityType: "credit_card" });
    const mortgage = updatedDebts.find((d) => d.plaidAccountId === "plaid-acct-mortgage-1");
    expect(mortgage).toMatchObject({ balance: 250000, apr: 6.25, liabilityType: "mortgage" });
    const loan = updatedDebts.find((d) => d.plaidAccountId === "plaid-acct-loan-1");
    expect(loan).toMatchObject({ balance: 15000, apr: 4.5, minimumPayment: 120, liabilityType: "student_loan" });

    // Never touched transactions.
    expect(localTransactions).toEqual(transactionsSnapshot);
  });
});
