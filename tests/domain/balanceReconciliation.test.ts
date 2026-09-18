import { describe, expect, it } from "vitest";
import {
  applyLedgerDelta,
  computeExpectedLedgerBalance,
  computeNetWorthForDate,
  computeWorkingBalance,
  dailyBalanceRecordId,
  filterBalanceTrackedAccounts,
  isLiabilityRole,
  localCalendarDate,
  reconcileAccountBalance,
} from "@/lib/domain/balanceReconciliation";
import type { Account, AccountBalanceSnapshot, DailyBalanceRecord, Transaction } from "@/lib/domain/types";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: "acct-checking",
    name: "Checking",
    role: "primary_pay",
    isManual: false,
    plaidAccountId: "plaid-acct-checking",
    ...overrides,
  };
}

function snapshot(overrides: Partial<AccountBalanceSnapshot> = {}): AccountBalanceSnapshot {
  return {
    id: "snap-1",
    accountId: "acct-checking",
    asOfBalance: 1000,
    asOfTimestamp: "2026-01-01T10:00:00.000Z",
    syncCursor: "cursor-1",
    priorSnapshotId: null,
    ...overrides,
  };
}

function txn(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "txn-1",
    accountId: "acct-checking",
    postedDate: "2026-01-01",
    pending: false,
    amount: 50,
    description: "Test",
    isTransfer: false,
    rawDescription: "Test",
    rawAmount: 50,
    rawDate: "2026-01-01",
    normalizedMerchantName: undefined,
    needsReview: false,
    ...overrides,
  };
}

describe("isLiabilityRole / applyLedgerDelta — role-aware direction", () => {
  it("credit_card and loan are liability-side; everything else is asset-side", () => {
    expect(isLiabilityRole("credit_card")).toBe(true);
    expect(isLiabilityRole("loan")).toBe(true);
    expect(isLiabilityRole("primary_pay")).toBe(false);
    expect(isLiabilityRole("savings")).toBe(false);
    expect(isLiabilityRole("hsa")).toBe(false);
    expect(isLiabilityRole("business")).toBe(false);
    expect(isLiabilityRole("other_manual")).toBe(false);
  });

  it("checking (asset) moves down, credit card and loan (liability) both move up, for the same positive amount", () => {
    const transactions = [txn({ amount: 75 })];
    expect(applyLedgerDelta("primary_pay", 1000, transactions)).toBe(925);
    expect(applyLedgerDelta("credit_card", 1000, transactions)).toBe(1075);
    expect(applyLedgerDelta("loan", 1000, transactions)).toBe(1075);
  });

  it("a liability payment (negative amount) reduces what's owed via the same formula, no special case", () => {
    const payment = [txn({ amount: -200 })];
    expect(applyLedgerDelta("credit_card", 1000, payment)).toBe(800);
  });
});

describe("computeExpectedLedgerBalance — firstPostedAt is the only boundary", () => {
  const prior = snapshot({ asOfTimestamp: "2026-01-10T00:00:00.000Z" });

  it("rolls forward a transaction whose firstPostedAt is after the snapshot", () => {
    const t = txn({ amount: 40, firstPostedAt: "2026-01-11T00:00:00.000Z" });
    expect(computeExpectedLedgerBalance(account(), prior, [t])).toBe(960);
  });

  it("excludes a transaction with no firstPostedAt at all, regardless of postedDate", () => {
    const t = txn({ amount: 40, postedDate: "2026-01-11", firstPostedAt: undefined });
    expect(computeExpectedLedgerBalance(account(), prior, [t])).toBe(1000);
  });

  it("excludes a transaction whose firstPostedAt is at or before the snapshot", () => {
    const before = txn({ amount: 40, firstPostedAt: "2026-01-10T00:00:00.000Z" });
    expect(computeExpectedLedgerBalance(account(), prior, [before])).toBe(1000);
  });

  it("respects an explicit asOfTimestamp upper bound", () => {
    const t = txn({ amount: 40, firstPostedAt: "2026-01-12T00:00:00.000Z" });
    expect(computeExpectedLedgerBalance(account(), prior, [t], "2026-01-11T00:00:00.000Z")).toBe(1000);
    expect(computeExpectedLedgerBalance(account(), prior, [t], "2026-01-13T00:00:00.000Z")).toBe(960);
  });

  it("includes transfer-flagged transactions (isTransfer only affects category totals)", () => {
    const t = txn({ amount: 40, isTransfer: true, firstPostedAt: "2026-01-11T00:00:00.000Z" });
    expect(computeExpectedLedgerBalance(account(), prior, [t])).toBe(960);
  });

  it("an old postedDate with a real post-baseline firstPostedAt is included — postedDate age has zero bearing", () => {
    const backdated = txn({ amount: 40, postedDate: "2020-01-01", firstPostedAt: "2026-01-11T00:00:00.000Z" });
    expect(computeExpectedLedgerBalance(account(), prior, [backdated])).toBe(960);
  });

  it("a recent postedDate whose firstPostedAt is actually pre-snapshot is excluded — postedDate alone would have implied the opposite", () => {
    const t = txn({ amount: 40, postedDate: "2026-01-12", firstPostedAt: "2026-01-09T00:00:00.000Z" });
    expect(computeExpectedLedgerBalance(account(), prior, [t])).toBe(1000);
  });

  it("never mutates the input transaction array", () => {
    const t = txn({ amount: 40, firstPostedAt: "2026-01-11T00:00:00.000Z" });
    const original = JSON.parse(JSON.stringify(t));
    computeExpectedLedgerBalance(account(), prior, [t]);
    expect(t).toEqual(original);
  });
});

describe("computeWorkingBalance — pending overlay uses the real boolean, never firstPostedAt's absence", () => {
  const latest = snapshot({ asOfTimestamp: "2026-01-10T00:00:00.000Z", asOfBalance: 1000 });

  it("a pending debit changes the working balance", () => {
    const pendingDebit = txn({ amount: 50, pending: true, firstPostedAt: undefined });
    expect(computeWorkingBalance(account(), latest, [pendingDebit])).toBe(950);
  });

  it("a pending credit changes the working balance in the other direction", () => {
    const pendingCredit = txn({ amount: -30, pending: true, firstPostedAt: undefined });
    expect(computeWorkingBalance(account(), latest, [pendingCredit])).toBe(1030);
  });

  it("a non-pending transaction lacking firstPostedAt is invisible — not ledger, not pending", () => {
    const legacy = txn({ amount: 999, pending: false, firstPostedAt: undefined });
    expect(computeWorkingBalance(account(), latest, [legacy])).toBe(1000);
  });

  it("the pending->posted regression: a transaction enters ledger math exactly once, never both pending and posted", () => {
    // While still pending (firstSeenAt before the snapshot, no firstPostedAt yet):
    const pendingStage = txn({ amount: 60, pending: true, firstPostedAt: undefined });
    expect(computeWorkingBalance(account(), latest, [pendingStage])).toBe(940);

    // Posts after the snapshot: pending flips false, firstPostedAt is set once.
    const postedStage = txn({ amount: 60, pending: false, firstPostedAt: "2026-01-11T00:00:00.000Z" });
    // Now excluded from the pending sum (pending !== true) and included in
    // the ledger roll-forward exactly once — never both, never neither.
    expect(computeWorkingBalance(account(), latest, [postedStage])).toBe(940);
  });
});

describe("reconcileAccountBalance — the reconciliation baseline/epoch", () => {
  it("case 1: an account with many legacy posted transactions gets a baseline with NO offset, regardless of their size", () => {
    const legacyTransactions = [
      txn({ id: "l1", amount: 10000, firstPostedAt: undefined }),
      txn({ id: "l2", amount: -5000, firstPostedAt: undefined }),
      txn({ id: "l3", amount: 250, firstPostedAt: undefined }),
    ];
    const result = reconcileAccountBalance({
      account: account(),
      priorSnapshot: undefined,
      confirmedBalance: 1234.56,
      observedAt: "2026-01-01T00:00:00.000Z",
      syncCursor: "cursor-baseline",
      balanceObservationId: "obs-baseline",
      transactionsForAccount: legacyTransactions,
    });
    expect(result.offset).toBeUndefined();
    expect(result.snapshot.asOfBalance).toBe(1234.56);
    expect(result.snapshot.priorSnapshotId).toBeNull();
  });

  it("case 2: a genuinely new post-baseline transaction rolls forward exactly once at the next reconciliation", () => {
    const baseline = snapshot({ id: "snap-baseline", asOfBalance: 1000, asOfTimestamp: "2026-01-01T00:00:00.000Z" });
    const newTxn = txn({ id: "new-1", amount: 40, firstPostedAt: "2026-01-02T00:00:00.000Z" });
    const result = reconcileAccountBalance({
      account: account(),
      priorSnapshot: baseline,
      confirmedBalance: 960,
      observedAt: "2026-01-03T00:00:00.000Z",
      syncCursor: "cursor-2",
      balanceObservationId: "obs-2",
      transactionsForAccount: [newTxn],
    });
    expect(result.offset).toBeUndefined();
    expect(result.snapshot.asOfBalance).toBe(960);
  });

  it("case 3: an old postedDate but a real post-baseline firstPostedAt is included the same as any other post-baseline activity", () => {
    const baseline = snapshot({ id: "snap-baseline", asOfBalance: 1000, asOfTimestamp: "2026-01-01T00:00:00.000Z" });
    const backdatedButNew = txn({
      id: "backdated-1",
      amount: 40,
      postedDate: "2015-06-01",
      firstPostedAt: "2026-01-02T00:00:00.000Z",
    });
    const result = reconcileAccountBalance({
      account: account(),
      priorSnapshot: baseline,
      confirmedBalance: 960,
      observedAt: "2026-01-03T00:00:00.000Z",
      syncCursor: "cursor-3",
      balanceObservationId: "obs-3",
      transactionsForAccount: [backdatedButNew],
    });
    expect(result.offset).toBeUndefined();
  });

  it("case 4: a legacy transaction stays excluded forever, across multiple subsequent reconciliation cycles", () => {
    const legacy = txn({ id: "legacy-1", amount: 99999, firstPostedAt: undefined });

    const baseline = reconcileAccountBalance({
      account: account(),
      priorSnapshot: undefined,
      confirmedBalance: 1000,
      observedAt: "2026-01-01T00:00:00.000Z",
      syncCursor: "cursor-b",
      balanceObservationId: "obs-b",
      transactionsForAccount: [legacy],
    });
    expect(baseline.offset).toBeUndefined();

    const cycle2 = reconcileAccountBalance({
      account: account(),
      priorSnapshot: baseline.snapshot,
      confirmedBalance: 1000,
      observedAt: "2026-01-02T00:00:00.000Z",
      syncCursor: "cursor-c2",
      balanceObservationId: "obs-c2",
      transactionsForAccount: [legacy],
    });
    expect(cycle2.offset).toBeUndefined();
    expect(legacy.firstPostedAt).toBeUndefined(); // never fabricated

    const cycle3 = reconcileAccountBalance({
      account: account(),
      priorSnapshot: cycle2.snapshot,
      confirmedBalance: 1000,
      observedAt: "2026-01-03T00:00:00.000Z",
      syncCursor: "cursor-c3",
      balanceObservationId: "obs-c3",
      transactionsForAccount: [legacy],
    });
    expect(cycle3.offset).toBeUndefined();
    expect(legacy.firstPostedAt).toBeUndefined();
  });
});

describe("reconcileAccountBalance — discrepancy detection", () => {
  const prior = snapshot({ asOfBalance: 1000, asOfTimestamp: "2026-01-01T00:00:00.000Z" });

  it("no discrepancy when the confirmed balance matches the expected ledger balance", () => {
    const result = reconcileAccountBalance({
      account: account(),
      priorSnapshot: prior,
      confirmedBalance: 1000,
      observedAt: "2026-01-02T00:00:00.000Z",
      syncCursor: "cursor",
      balanceObservationId: "obs",
      transactionsForAccount: [],
    });
    expect(result.offset).toBeUndefined();
  });

  it("a positive discrepancy (confirmed higher than expected) is recorded", () => {
    const result = reconcileAccountBalance({
      account: account(),
      priorSnapshot: prior,
      confirmedBalance: 1050,
      observedAt: "2026-01-02T00:00:00.000Z",
      syncCursor: "cursor",
      balanceObservationId: "obs",
      transactionsForAccount: [],
    });
    expect(result.offset?.amount).toBe(50);
    expect(result.offset?.priorSnapshotId).toBe(prior.id);
    expect(result.offset?.newSnapshotId).toBe(result.snapshot.id);
  });

  it("a negative discrepancy (confirmed lower than expected) is recorded", () => {
    const result = reconcileAccountBalance({
      account: account(),
      priorSnapshot: prior,
      confirmedBalance: 950,
      observedAt: "2026-01-02T00:00:00.000Z",
      syncCursor: "cursor",
      balanceObservationId: "obs",
      transactionsForAccount: [],
    });
    expect(result.offset?.amount).toBe(-50);
  });

  it("a sub-cent-level difference stays within epsilon and creates no offset", () => {
    const result = reconcileAccountBalance({
      account: account(),
      priorSnapshot: prior,
      confirmedBalance: 1000.004,
      observedAt: "2026-01-02T00:00:00.000Z",
      syncCursor: "cursor",
      balanceObservationId: "obs",
      transactionsForAccount: [],
    });
    expect(result.offset).toBeUndefined();
  });

  it("never rewrites transaction history — the input array is unchanged after a discrepancy-producing reconcile", () => {
    const transactions = [txn({ amount: 20, firstPostedAt: "2026-01-02T00:00:00.000Z" })];
    const original = JSON.parse(JSON.stringify(transactions));
    reconcileAccountBalance({
      account: account(),
      priorSnapshot: prior,
      confirmedBalance: 5000, // wildly different from expected -> guaranteed offset
      observedAt: "2026-01-03T00:00:00.000Z",
      syncCursor: "cursor",
      balanceObservationId: "obs",
      transactionsForAccount: transactions,
    });
    expect(transactions).toEqual(original);
  });
});

describe("the late-discovered / already-in-balance transaction: a self-correcting offset pair", () => {
  it("produces two offsets that sum to zero, counts T exactly once, and a third cycle produces no further offset", () => {
    const acct = account();

    // S0: baseline, $1,000, no known activity.
    const s0 = reconcileAccountBalance({
      account: acct,
      priorSnapshot: undefined,
      confirmedBalance: 1000,
      observedAt: "2026-01-01T10:00:00.000Z",
      syncCursor: "cursor-0",
      balanceObservationId: "obs-0",
      transactionsForAccount: [],
    });
    expect(s0.offset).toBeUndefined();

    // Between S0 and the next fetch, T ($50 outflow) posts at the bank a
    // moment after a sync completed — too late for BASELINE to have seen
    // it, but Plaid's balance fetch already reflects it.
    const s1 = reconcileAccountBalance({
      account: acct,
      priorSnapshot: s0.snapshot,
      confirmedBalance: 950,
      observedAt: "2026-01-01T10:00:02.000Z",
      syncCursor: "cursor-1",
      balanceObservationId: "obs-1",
      transactionsForAccount: [], // T not yet known locally
    });
    expect(s1.offset?.amount).toBe(-50);

    // T is discovered at the next sync; its real firstPostedAt is after S1.
    const t = txn({ id: "t-late", amount: 50, firstPostedAt: "2026-01-01T11:00:00.000Z" });

    // Reconciling S1 -> S2: confirmed balance unchanged at $950, but now
    // T rolls forward from S1, producing expected = $900 -> offset +$50.
    const s2 = reconcileAccountBalance({
      account: acct,
      priorSnapshot: s1.snapshot,
      confirmedBalance: 950,
      observedAt: "2026-01-01T12:00:00.000Z",
      syncCursor: "cursor-2",
      balanceObservationId: "obs-2",
      transactionsForAccount: [t],
    });
    expect(s2.offset?.amount).toBe(50);

    expect((s1.offset?.amount ?? 0) + (s2.offset?.amount ?? 0)).toBe(0);
    expect(t.firstPostedAt).toBe("2026-01-01T11:00:00.000Z"); // set exactly once, never revised

    // A third cycle with no further activity produces no additional offset.
    const s3 = reconcileAccountBalance({
      account: acct,
      priorSnapshot: s2.snapshot,
      confirmedBalance: 950,
      observedAt: "2026-01-01T13:00:00.000Z",
      syncCursor: "cursor-3",
      balanceObservationId: "obs-3",
      transactionsForAccount: [t],
    });
    expect(s3.offset).toBeUndefined();
  });
});

describe("dailyBalanceRecordId / localCalendarDate", () => {
  it("is deterministic from account + date, matching the SQL-side 'daily-' || account_id || '-' || date construction", () => {
    expect(dailyBalanceRecordId("acct-checking", "2026-01-05")).toBe("daily-acct-checking-2026-01-05");
    expect(dailyBalanceRecordId("acct-checking", "2026-01-05")).toBe(dailyBalanceRecordId("acct-checking", "2026-01-05"));
  });

  it("resolves the local calendar date for an explicit IANA timezone, not a UTC slice", () => {
    // 2026-01-01T02:00:00Z is still 2025-12-31 evening in New York.
    const instant = new Date("2026-01-01T02:00:00.000Z");
    expect(localCalendarDate(instant, "America/New_York")).toBe("2025-12-31");
    expect(localCalendarDate(instant, "UTC")).toBe("2026-01-01");
  });
});

describe("filterBalanceTrackedAccounts", () => {
  it("excludes a manual account and includes a Plaid-linked one", () => {
    const manual = account({ id: "acct-manual", plaidAccountId: undefined, isManual: true });
    const linked = account({ id: "acct-linked", plaidAccountId: "plaid-linked" });
    expect(filterBalanceTrackedAccounts([manual, linked])).toEqual([linked]);
  });
});

describe("computeNetWorthForDate", () => {
  const checking = account({ id: "acct-checking", role: "primary_pay" });
  const savings = account({ id: "acct-savings", role: "savings", plaidAccountId: "plaid-savings" });
  const creditCard = account({ id: "acct-cc", role: "credit_card", plaidAccountId: "plaid-cc" });
  const loan = account({ id: "acct-loan", role: "loan", plaidAccountId: "plaid-loan" });
  const trackedAccounts = [checking, savings, creditCard, loan];

  function record(accountId: string, balance: number): DailyBalanceRecord {
    return { id: dailyBalanceRecordId(accountId, "2026-01-05"), accountId, date: "2026-01-05", balance };
  }

  it("$2,000 checking + $1,000 savings - $400 credit card - $600 loan = $2,000", () => {
    const records = [
      record("acct-checking", 2000),
      record("acct-savings", 1000),
      record("acct-cc", 400),
      record("acct-loan", 600),
    ];
    const result = computeNetWorthForDate(records, trackedAccounts, "2026-01-05");
    expect(result.netWorth).toBe(2000);
    expect(result.complete).toBe(true);
    expect(result.missingAccountIds).toEqual([]);
  });

  it("an account missing a record for that date is excluded from the sums and reported incomplete", () => {
    const records = [record("acct-checking", 2000), record("acct-savings", 1000), record("acct-cc", 400)];
    const result = computeNetWorthForDate(records, trackedAccounts, "2026-01-05");
    expect(result.complete).toBe(false);
    expect(result.missingAccountIds).toEqual(["acct-loan"]);
    expect(result.netWorth).toBe(2600); // 2000 + 1000 - 400, loan excluded entirely
  });
});
