// Balance reconciliation (rv2.6, Step 6).
//
// Additive module — payWindow.ts, paycheck.ts, sweep.ts,
// categoryAllocation.ts, calendarReporting.ts, merchantMemory.ts,
// transactionSplits.ts, and transferDetection.ts are all untouched.
// Nothing here knows about concurrency, atomicity, or persistence —
// that's the orchestration layer (syncOrchestration.ts) and the
// reconcile_account_balance RPC (persistence.ts), layered around these
// pure functions, which stay simple.
//
// Ledger boundary: computeExpectedLedgerBalance/computeWorkingBalance
// read ONLY firstPostedAt — never postedDate, never raw transaction
// date, never firstSeenAt's absence as a proxy for "pending." A
// transaction whose firstPostedAt is unset (never posted, or a
// pre-Step-6 legacy row that predates this field entirely) is excluded
// from ledger math by construction — this IS the reconciliation
// baseline/epoch mechanism: an account's first-ever snapshot
// establishes ground truth unconditionally (see reconcileAccountBalance
// below), and every transaction that predates it stays permanently
// invisible to ledger math with no fabricated timestamp ever involved.

import type {
  Account,
  AccountBalanceSnapshot,
  AccountRole,
  DailyBalanceRecord,
  IsoDate,
  ReconciliationOffset,
  Transaction,
} from "./types";

function round2(amount: number): number {
  return Math.round(amount * 100) / 100;
}

const RECONCILIATION_EPSILON = 0.005;

/** The single shared definition of "liability-side" — used by both
 * applyLedgerDelta and computeNetWorthForDate, so there is one place
 * this judgment call lives, not two that could drift apart. */
export function isLiabilityRole(role: AccountRole): boolean {
  return role === "credit_card" || role === "loan";
}

/** Account-role-specific balance delta. Asset-side: a positive
 * (outflow-per-Plaid-convention) amount reduces the balance.
 * Liability-side (credit_card, loan): a positive amount (a purchase)
 * increases what's owed; a payment arrives as a negative amount and
 * correctly reduces it via this same formula, no special case. */
export function applyLedgerDelta(role: AccountRole, priorBalance: number, transactions: Transaction[]): number {
  const sum = transactions.reduce((total, t) => total + t.amount, 0);
  return isLiabilityRole(role) ? priorBalance + sum : priorBalance - sum;
}

/** Rolls forward from snapshot.asOfBalance using transactions whose
 * firstPostedAt is strictly after the snapshot's own asOfTimestamp
 * (and, if asOfTimestamp is given, no later than it — a real timestamp
 * bound, always; never a bare date). A transaction with
 * firstPostedAt === undefined is excluded — it has never posted, by
 * construction of how that field is set (see types.ts). Includes
 * transfer-flagged transactions: isTransfer only affects category
 * totals, unrelated to account balance. Direction is role-aware via
 * applyLedgerDelta. postedDate and raw transaction date are never read
 * here, by any code path — only firstPostedAt, always. */
export function computeExpectedLedgerBalance(
  account: Account,
  snapshot: AccountBalanceSnapshot,
  transactionsForAccount: Transaction[],
  asOfTimestamp?: string
): number {
  const matching = transactionsForAccount.filter((t) => {
    if (t.firstPostedAt === undefined) return false;
    if (t.firstPostedAt <= snapshot.asOfTimestamp) return false;
    if (asOfTimestamp !== undefined && t.firstPostedAt > asOfTimestamp) return false;
    return true;
  });
  return applyLedgerDelta(account.role, snapshot.asOfBalance, matching);
}

/** The user-facing between-sync balance: computeExpectedLedgerBalance
 * (unbounded — "as of right now") plus every transaction where
 * transaction.pending === true, the real boolean field, checked
 * directly — NEVER inferred from firstPostedAt's absence, since the two
 * are not equivalent (a manually-entered or pre-Step-6 transaction can
 * have pending: false and still lack firstPostedAt, and must not be
 * swept into this sum because of that). No double-counting across a
 * real pending->posted transition: while pending it's in the pending
 * sum only; once reconcilePendingToPosted flips pending to false and
 * sets firstPostedAt, it moves into ledger math and out of the pending
 * sum — never both, never neither. */
export function computeWorkingBalance(
  account: Account,
  latestSnapshot: AccountBalanceSnapshot,
  transactionsForAccount: Transaction[]
): number {
  const ledger = computeExpectedLedgerBalance(account, latestSnapshot, transactionsForAccount);
  const pending = transactionsForAccount.filter((t) => t.pending === true);
  return applyLedgerDelta(account.role, ledger, pending);
}

export interface ReconcileAccountBalanceInput {
  account: Account;
  priorSnapshot?: AccountBalanceSnapshot;
  confirmedBalance: number;
  observedAt: string;
  syncCursor: string;
  /** Generated once per orchestration attempt (see syncOrchestration.ts)
   * — never derived from syncCursor or confirmedBalance. This is what
   * makes every successful balance fetch a distinct, immutable
   * observation, even one that happens to repeat an earlier cursor
   * and/or balance value. */
  balanceObservationId: string;
  transactionsForAccount: Transaction[];
}

export interface ReconcileAccountBalanceResult {
  snapshot: AccountBalanceSnapshot;
  offset?: ReconciliationOffset;
}

/**
 * The core reconciliation step for one account, one balance
 * observation. No priorSnapshot establishes the account's
 * reconciliation baseline/epoch: a first-class design decision, not a
 * degenerate case. There is no such thing as a discrepancy at the
 * baseline — its whole purpose is to establish ground truth, not to be
 * judged against a prior expectation. confirmedBalance becomes
 * snapshot.asOfBalance directly and unconditionally; every local
 * transaction that predates this moment (including any pre-Step-6
 * legacy transaction whose firstPostedAt was never set, simply because
 * it existed before this field did) is intentionally and permanently
 * invisible to all ledger math from this point forward, with nothing
 * ever fabricated or inferred to explain it away.
 */
export function reconcileAccountBalance(input: ReconcileAccountBalanceInput): ReconcileAccountBalanceResult {
  const { account, priorSnapshot, confirmedBalance, observedAt, syncCursor, balanceObservationId, transactionsForAccount } =
    input;

  const snapshot: AccountBalanceSnapshot = {
    id: `snapshot-${account.id}-${balanceObservationId}`,
    accountId: account.id,
    asOfBalance: confirmedBalance,
    asOfTimestamp: observedAt,
    syncCursor,
    priorSnapshotId: priorSnapshot?.id ?? null,
  };

  if (!priorSnapshot) {
    return { snapshot };
  }

  const expected = computeExpectedLedgerBalance(account, priorSnapshot, transactionsForAccount, observedAt);
  const discrepancy = round2(confirmedBalance - expected);

  if (Math.abs(discrepancy) < RECONCILIATION_EPSILON) {
    return { snapshot };
  }

  return {
    snapshot,
    offset: {
      id: `offset-${account.id}-${snapshot.id}`,
      accountId: account.id,
      amount: discrepancy,
      priorSnapshotId: priorSnapshot.id,
      newSnapshotId: snapshot.id,
      occurredAt: observedAt,
    },
  };
}

/** The deterministic daily-record id format, shared textually with the
 * SQL side ('daily-' || account_id || '-' || date::text in the
 * reconcile_account_balance RPC) so both sides always agree on what a
 * given account+day's id is. This module never constructs a full
 * DailyBalanceRecord object for the write path — that would let a
 * balance distinct from snapshot.asOfBalance reach persistence, which
 * must be structurally impossible. Daily history is derived entirely,
 * inside the RPC, from a reconciliation event's own account/balance
 * plus the caller-supplied local date. */
export function dailyBalanceRecordId(accountId: string, date: IsoDate): string {
  return `daily-${accountId}-${date}`;
}

/** The local (IANA-timezone) calendar date for a given instant, using
 * native Intl — no new dependency, correct across DST since it defers
 * to the ICU timezone database rather than manual UTC-offset math.
 * en-CA formats as YYYY-MM-DD, a reliable way to get an ISO-shaped
 * local date out of Intl.DateTimeFormat. */
export function localCalendarDate(instant: Date, timezone: string): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    instant
  );
}

/** The single source of truth for "what counts as balance-tracked" for
 * net-worth purposes: Plaid-linked accounts only. Step 6 builds
 * DailyBalanceRecords exclusively from Plaid balance observations; a
 * manual account has no mechanism to ever receive one. Every caller is
 * expected to call this BEFORE calling computeNetWorthForDate, rather
 * than re-deciding the population itself. */
export function filterBalanceTrackedAccounts(accounts: Account[]): Account[] {
  return accounts.filter((a) => a.plaidAccountId !== undefined);
}

export interface NetWorthResult {
  netWorth: number;
  complete: boolean;
  missingAccountIds: string[];
}

/**
 * Sums each balance-tracked account's DailyBalanceRecord for the given
 * date, explicitly as assets MINUS liabilities — applyLedgerDelta moves
 * a liability balance in the "amount owed" direction but never stores
 * it as negative, so net worth must explicitly subtract, never blindly
 * sum. Any account in trackedAccounts with no record for that date is
 * excluded from both sums and listed in missingAccountIds; complete is
 * false whenever that list is non-empty — a partial figure is never
 * silently presented as whole. trackedAccounts MUST already be filtered
 * via filterBalanceTrackedAccounts — this function does not re-filter.
 */
export function computeNetWorthForDate(
  dailyRecords: DailyBalanceRecord[],
  trackedAccounts: Account[],
  date: IsoDate
): NetWorthResult {
  const recordsForDate = dailyRecords.filter((r) => r.date === date);
  const recordByAccountId = new Map(recordsForDate.map((r) => [r.accountId, r]));

  let assetSum = 0;
  let liabilitySum = 0;
  const missingAccountIds: string[] = [];

  for (const account of trackedAccounts) {
    const record = recordByAccountId.get(account.id);
    if (!record) {
      missingAccountIds.push(account.id);
      continue;
    }
    if (isLiabilityRole(account.role)) {
      liabilitySum += record.balance;
    } else {
      assetSum += record.balance;
    }
  }

  return {
    netWorth: round2(assetSum - liabilitySum),
    complete: missingAccountIds.length === 0,
    missingAccountIds,
  };
}
