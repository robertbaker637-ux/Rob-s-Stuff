import { describe, expect, it } from "vitest";
import {
  canonicalAccountPairKey,
  confirmTransferLink,
  findTransferCandidates,
  scoreTransferCandidate,
} from "@/lib/domain/transferDetection";
import {
  computeCategoryBalanceForWindow,
  filterTransactionsForCategoryWindow,
} from "@/lib/domain/categoryAllocation";
import type { PaySchedule, Transaction, TransferPairHistory } from "@/lib/domain/types";

const ckSchedule: PaySchedule = {
  id: "sched-ck",
  incomeSourceId: "src-ck",
  cadence: "biweekly",
  anchorDate: "2026-01-02",
};

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    id: "t1",
    accountId: "acct-checking",
    postedDate: "2026-01-05",
    pending: false,
    amount: 350,
    description: "Transfer",
    isTransfer: false,
    rawDescription: "Transfer",
    rawAmount: 350,
    rawDate: "2026-01-05",
    needsReview: false,
    ...overrides,
  };
}

describe("scoreTransferCandidate — candidacy prerequisites", () => {
  it("same amount, same day, opposite signs, but the SAME account -> not a candidate", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 300 });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-checking", amount: -300 });

    const result = scoreTransferCandidate(txnA, txnB, []);
    expect(result.confidence).toBe("none");
    expect(result.score).toBe(0);

    // And it must never surface from the pairing entry point either.
    const candidates = findTransferCandidates([txnA, txnB], []);
    expect(candidates).toHaveLength(0);
  });

  it("same account, same direction (both positive) -> not a candidate", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 100 });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-checking", amount: 100 });
    expect(scoreTransferCandidate(txnA, txnB, []).confidence).toBe("none");
  });

  it("different accounts but SAME direction (both outflows) -> not a candidate", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 100 });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-savings", amount: 100 });
    expect(scoreTransferCandidate(txnA, txnB, []).confidence).toBe("none");
  });

  it("amount similarity compares absolute values regardless of sign", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 200 });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-savings", amount: -200 });
    const result = scoreTransferCandidate(txnA, txnB, []);
    // Exact |200| == |-200| match should award the full exact-amount points.
    expect(result.score).toBeGreaterThanOrEqual(2);
  });
});

describe("scoreTransferCandidate — confidence levels", () => {
  it("high confidence: exact amount, same day, different accounts, opposite directions", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 350, postedDate: "2026-01-05" });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-savings", amount: -350, postedDate: "2026-01-05" });

    const result = scoreTransferCandidate(txnA, txnB, []);
    expect(result.confidence).toBe("high");
  });

  it("low confidence (ambiguous): near amount, a few days apart, no prior history on the pair", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 200, postedDate: "2026-01-05" });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-savings", amount: -198, postedDate: "2026-01-08" });

    const result = scoreTransferCandidate(txnA, txnB, []);
    expect(result.confidence).toBe("low");
  });

  it("confirmed account-pair history increases future confidence: the same ambiguous pattern crosses from low to high once that pair has a confirmed match", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 200, postedDate: "2026-01-05" });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-savings", amount: -198, postedDate: "2026-01-08" });

    const withoutHistory = scoreTransferCandidate(txnA, txnB, []);
    expect(withoutHistory.confidence).toBe("low");

    const history: TransferPairHistory[] = [
      { id: "pair-1", accountAId: "acct-checking", accountBId: "acct-savings", confirmedCount: 1 },
    ];
    const withHistory = scoreTransferCandidate(txnA, txnB, history);
    expect(withHistory.confidence).toBe("high");
    expect(withHistory.score).toBeGreaterThan(withoutHistory.score);
  });

  it("account-pair history lookup is order-independent (canonicalAccountPairKey)", () => {
    expect(canonicalAccountPairKey("acct-checking", "acct-savings")).toBe(
      canonicalAccountPairKey("acct-savings", "acct-checking")
    );
  });
});

describe("confirmTransferLink", () => {
  it("links both legs with a shared transferLinkId and sets isTransfer on both", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 350 });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-savings", amount: -350 });

    const { txnA: updatedA, txnB: updatedB } = confirmTransferLink(txnA, txnB, []);
    expect(updatedA.isTransfer).toBe(true);
    expect(updatedB.isTransfer).toBe(true);
    expect(updatedA.transferLinkId).toBe(updatedB.transferLinkId);
    expect(updatedA.transferLinkId).toBeDefined();
  });

  it("creates pair history on first confirmation, increments it on subsequent ones", () => {
    const txnA = makeTransaction({ id: "t1", accountId: "acct-checking", amount: 350 });
    const txnB = makeTransaction({ id: "t2", accountId: "acct-savings", amount: -350 });

    const first = confirmTransferLink(txnA, txnB, []);
    expect(first.pairHistory).toHaveLength(1);
    expect(first.pairHistory[0].confirmedCount).toBe(1);

    const txnC = makeTransaction({ id: "t3", accountId: "acct-checking", amount: 100 });
    const txnD = makeTransaction({ id: "t4", accountId: "acct-savings", amount: -100 });
    const second = confirmTransferLink(txnC, txnD, first.pairHistory);
    expect(second.pairHistory).toHaveLength(1); // same pair, not a new row
    expect(second.pairHistory[0].confirmedCount).toBe(2);
  });
});

describe("transfers stay excluded from spending/category totals", () => {
  it("a confirmed, linked transfer (with transferLinkId set) is still excluded by the existing category-window filter", () => {
    const window = { start: "2026-01-02", end: "2026-01-16" };
    const txnA = makeTransaction({
      id: "t1",
      accountId: "acct-checking",
      amount: 350,
      postedDate: "2026-01-05",
      categoryId: "cat-groceries", // even if mis-tagged with a category, isTransfer wins
    });
    const txnB = makeTransaction({
      id: "t2",
      accountId: "acct-savings",
      amount: -350,
      postedDate: "2026-01-05",
    });

    const { txnA: linkedA } = confirmTransferLink(txnA, txnB, []);
    expect(linkedA.transferLinkId).toBeDefined();

    const inWindow = filterTransactionsForCategoryWindow([linkedA], "cat-groceries", window, ckSchedule);
    expect(inWindow).toHaveLength(0);
    expect(computeCategoryBalanceForWindow(150, inWindow)).toBe(150);
  });
});
