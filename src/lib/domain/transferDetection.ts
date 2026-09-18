// Confidence-based internal transfer detection (rv2.3, Step 4).
//
// Same amount leaving one linked account and landing in another around
// the same date is a CANDIDATE transfer, not automatic proof. Scoring
// produces a confidence level rather than a binary rule: high-confidence
// matches are auto-link eligible, lower-confidence ones surface for
// one-tap confirmation. Confirming a pair grows that account pair's
// history, so future matches on the same pair gain confidence over time.
//
// Sign convention (this is local data, so it's ours to define — chosen
// to match Plaid's real convention for forward compatibility with Step
// 5): a transaction's `amount` is positive for an outflow (money leaving
// its account) and negative for an inflow (money arriving). A transfer
// pair is always one leg of each.

import { daysBetween, parseIsoDate } from "./dateUtil";
import type {
  Transaction,
  TransferCandidate,
  TransferConfidence,
  TransferPairHistory,
} from "./types";

const AMOUNT_NEAR_MATCH_TOLERANCE = 0.02; // 2%
const DATE_NEAR_MATCH_WINDOW_DAYS = 3;
const HIGH_CONFIDENCE_THRESHOLD = 4;

export function canonicalAccountPairKey(accountAId: string, accountBId: string): string {
  return [accountAId, accountBId].sort().join("::");
}

function findPairHistory(
  pairHistory: TransferPairHistory[],
  accountAId: string,
  accountBId: string
): TransferPairHistory | undefined {
  const key = canonicalAccountPairKey(accountAId, accountBId);
  return pairHistory.find((h) => canonicalAccountPairKey(h.accountAId, h.accountBId) === key);
}

interface ScoreResult {
  confidence: TransferConfidence;
  score: number;
}

/**
 * Scores a candidate transfer pair. The candidacy PREREQUISITES live
 * here, not just in the caller that pairs transactions up — different
 * accounts and opposite directions are checked first and short-circuit
 * to "none" before any point-scoring happens, so nothing downstream can
 * accidentally treat a same-account or same-direction pair as a
 * transfer candidate.
 */
export function scoreTransferCandidate(
  txnA: Transaction,
  txnB: Transaction,
  pairHistory: TransferPairHistory[]
): ScoreResult {
  if (txnA.accountId === txnB.accountId) {
    return { confidence: "none", score: 0 };
  }
  if (Math.sign(txnA.amount) === Math.sign(txnB.amount)) {
    // Same direction (both outflows or both inflows) — a transfer is
    // one leg of each, never two of the same.
    return { confidence: "none", score: 0 };
  }

  let score = 0;

  const amountA = Math.abs(txnA.amount);
  const amountB = Math.abs(txnB.amount);
  if (amountA === amountB) {
    score += 2;
  } else {
    const largerAmount = Math.max(amountA, amountB);
    const diffRatio = largerAmount === 0 ? Infinity : Math.abs(amountA - amountB) / largerAmount;
    if (diffRatio <= AMOUNT_NEAR_MATCH_TOLERANCE) {
      score += 1;
    } else {
      return { confidence: "none", score: 0 };
    }
  }

  const daysApart = Math.abs(daysBetween(parseIsoDate(txnA.postedDate), parseIsoDate(txnB.postedDate)));
  if (daysApart === 0) {
    score += 2;
  } else if (daysApart <= DATE_NEAR_MATCH_WINDOW_DAYS) {
    score += 1;
  } else {
    return { confidence: "none", score: 0 };
  }

  const history = findPairHistory(pairHistory, txnA.accountId, txnB.accountId);
  if (history && history.confirmedCount > 0) {
    score += 2;
  }

  const confidence: TransferConfidence = score >= HIGH_CONFIDENCE_THRESHOLD ? "high" : "low";
  return { confidence, score };
}

/** Scores every pair of transactions, returning only genuine candidates
 * (confidence "high" or "low" — "none" pairs are dropped, not returned). */
export function findTransferCandidates(
  transactions: Transaction[],
  pairHistory: TransferPairHistory[]
): TransferCandidate[] {
  const candidates: TransferCandidate[] = [];

  for (let i = 0; i < transactions.length; i++) {
    for (let j = i + 1; j < transactions.length; j++) {
      const txnA = transactions[i];
      const txnB = transactions[j];
      const { confidence, score } = scoreTransferCandidate(txnA, txnB, pairHistory);
      if (confidence === "none") continue;
      candidates.push({ transactionAId: txnA.id, transactionBId: txnB.id, confidence, score });
    }
  }

  return candidates;
}

/**
 * Confirms a transfer: links both legs via a shared transferLinkId, sets
 * isTransfer on both, and grows the account pair's confirmed history so
 * future matches on this pair score higher. Pure — returns new objects.
 */
export function confirmTransferLink(
  txnA: Transaction,
  txnB: Transaction,
  pairHistory: TransferPairHistory[]
): { txnA: Transaction; txnB: Transaction; pairHistory: TransferPairHistory[] } {
  const linkId = `xfer-${[txnA.id, txnB.id].sort().join("-")}`;
  const updatedA: Transaction = { ...txnA, isTransfer: true, transferLinkId: linkId };
  const updatedB: Transaction = { ...txnB, isTransfer: true, transferLinkId: linkId };

  const existing = findPairHistory(pairHistory, txnA.accountId, txnB.accountId);
  let updatedHistory: TransferPairHistory[];
  if (existing) {
    updatedHistory = pairHistory.map((h) =>
      h.id === existing.id ? { ...h, confirmedCount: h.confirmedCount + 1 } : h
    );
  } else {
    const [accountAId, accountBId] = [txnA.accountId, txnB.accountId].sort();
    updatedHistory = [
      ...pairHistory,
      {
        id: `pair-${canonicalAccountPairKey(txnA.accountId, txnB.accountId)}`,
        accountAId,
        accountBId,
        confirmedCount: 1,
      },
    ];
  }

  return { txnA: updatedA, txnB: updatedB, pairHistory: updatedHistory };
}

