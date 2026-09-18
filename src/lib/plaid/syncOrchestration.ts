// /transactions/sync pagination + cursor safety (rv2.4).
//
// Kept separate from src/lib/domain/plaidSync.ts: that module stays
// pure/synchronous (its existing convention), while this one is
// inherently async I/O orchestration. It's still fully unit-testable by
// taking an INJECTED page-fetcher rather than calling the Plaid SDK
// directly — the real route handler supplies a fetcher backed by
// plaidClient.transactionsSync; tests supply a mock.

import { localCalendarDate, reconcileAccountBalance } from "@/lib/domain/balanceReconciliation";
import { syncPlaidTransactions } from "@/lib/domain/plaidSync";
import type {
  Account,
  AccountBalanceSnapshot,
  IsoDate,
  MerchantRule,
  PlaidBalanceObservation,
  PlaidSyncBatch,
  PlaidTransactionData,
  ReconciliationOffset,
  SyncResult,
  Transaction,
} from "@/lib/domain/types";

export interface PlaidSyncPage {
  added: PlaidTransactionData[];
  modified: PlaidTransactionData[];
  removed: { transactionId: string }[];
  nextCursor: string;
  hasMore: boolean;
}

export type FetchSyncPage = (cursor: string) => Promise<PlaidSyncPage>;

const MUTATION_DURING_PAGINATION_ERROR_CODE = "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION";

function isMutationDuringPaginationError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "error_code" in err &&
    (err as { error_code?: unknown }).error_code === MUTATION_DURING_PAGINATION_ERROR_CODE
  );
}

/**
 * Walks every page of /transactions/sync starting from `startingCursor`,
 * accumulating added/modified/removed across all of them, and returns
 * only once a page reports hasMore: false. A pending transaction's
 * `removed` entry on one page and its posted `added` replacement on a
 * later page both land in the SAME returned batch — reconciliation
 * (syncPlaidTransactions) never sees a partial page-by-page view.
 *
 * On TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: discards everything
 * accumulated so far and restarts the entire walk from the ORIGINAL
 * `startingCursor` — never resumes from the page that failed, per
 * Plaid's required behavior.
 */
export async function fetchCompletePlaidSyncBatch(
  fetchPage: FetchSyncPage,
  startingCursor: string
): Promise<{ batch: PlaidSyncBatch; finalCursor: string }> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const added: PlaidTransactionData[] = [];
    const modified: PlaidTransactionData[] = [];
    const removed: { transactionId: string }[] = [];
    let cursor = startingCursor;

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const page = await fetchPage(cursor);
        added.push(...page.added);
        modified.push(...page.modified);
        removed.push(...page.removed);
        cursor = page.nextCursor;
        if (!page.hasMore) {
          return { batch: { added, modified, removed }, finalCursor: cursor };
        }
      }
    } catch (err) {
      if (isMutationDuringPaginationError(err)) {
        continue; // restart the outer loop from startingCursor
      }
      throw err;
    }
  }
}

export interface RunPlaidTransactionsSyncParams {
  fetchPage: FetchSyncPage;
  startingCursor: string;
  localTransactions: Transaction[];
  accountIdByPlaidAccountId: Map<string, string>;
  merchantRules: MerchantRule[];
  /** Persists the merged transaction list. Must throw/reject on failure
   * — runPlaidTransactionsSync relies on that to avoid ever returning a
   * cursor for a sync that wasn't actually saved. */
  persistTransactions: (transactions: Transaction[]) => Promise<void>;
}

/**
 * The full sync: fetch every page (with pagination-mutation restart
 * handled transparently), merge via the pure syncPlaidTransactions, then
 * persist. Returns `newCursor` ONLY once persistTransactions has
 * resolved successfully — if it rejects, this function rejects too and
 * produces no cursor at all, so the caller (the /api/plaid/sync route
 * handler) can never advance plaid_items.transactions_cursor for a sync
 * that wasn't actually saved.
 */
export async function runPlaidTransactionsSync(
  params: RunPlaidTransactionsSyncParams
): Promise<{ syncResult: SyncResult; newCursor: string }> {
  const { batch, finalCursor } = await fetchCompletePlaidSyncBatch(
    params.fetchPage,
    params.startingCursor
  );

  const syncResult = syncPlaidTransactions(
    params.localTransactions,
    batch,
    params.accountIdByPlaidAccountId,
    params.merchantRules
  );

  await params.persistTransactions(syncResult.transactions);

  return { syncResult, newCursor: finalCursor };
}

// ============================================================================
// Balance reconciliation (rv2.6, Step 6)
// ============================================================================

/** The balance fetch owns its own timestamp — observedAt is captured at
 * the moment the Plaid call actually resolves (see
 * syncAdapters.ts's fetchAccountBalanceObservation), never supplied
 * independently by a caller. exchange-public-token/route.ts, which
 * already calls accountsBalanceGet for liability lookups, instead wraps
 * that already-captured observation in a closure returning it directly
 * — no second fetch, no re-timestamping. */
export type FetchBalanceObservation = () => Promise<PlaidBalanceObservation>;

export interface ReconciliationEvent {
  /** No top-level accountId here, deliberately — it would be a second,
   * independently-suppliable copy of snapshot.accountId that could
   * disagree with it. persistReconciliationEvent derives the RPC's
   * account parameter from snapshot.accountId alone, the one canonical
   * account identity for this whole event. Likewise there is no
   * separate prior-chain field: that's snapshot.priorSnapshotId. And no
   * dailyRecord object: a DailyBalanceRecord's account and balance are
   * always exactly snapshot.accountId and snapshot.asOfBalance — the
   * RPC derives both in SQL. The one genuinely independent piece of
   * information this event carries beyond the snapshot/offset
   * themselves is WHICH local calendar day the confirmed balance
   * applies to — a timezone-dependent computation with no other
   * canonical source to derive from. */
  snapshot: AccountBalanceSnapshot;
  offset?: ReconciliationOffset;
  localDate: IsoDate;
}

export interface RunAccountBalanceReconciliationParams {
  accounts: Account[];
  fetchBalances: FetchBalanceObservation;
  syncCursor: string;
  getLatestSnapshot: (accountId: string) => Promise<AccountBalanceSnapshot | undefined>;
  loadTransactionsForAccount: (accountId: string) => Promise<Transaction[]>;
  /** ONE atomic, compare-and-swapped persistence call per account — see
   * the reconcile_account_balance RPC. Rejects with a recognizable
   * stale-baseline error (checked via isStaleBaselineError) if
   * event.snapshot.priorSnapshotId no longer matches the account's
   * actual latest snapshot; any other rejection is a real failure and
   * is never auto-retried. */
  persistReconciliationEvent: (event: ReconciliationEvent) => Promise<void>;
  timezone: string;
  /** Defaults to crypto.randomUUID, called once per account. */
  generateObservationId?: () => string;
}

const STALE_BASELINE_SQLSTATE = "B0001";

/** Checks the SQLSTATE the reconcile_account_balance RPC raises
 * specifically for a lost compare-and-swap race (a fork attempt,
 * including on the null/baseline prior-snapshot case) — the ONLY error
 * code runAccountBalanceReconciliation ever auto-retries. Any other
 * code (or no code at all) is a real failure and propagates untouched. */
export function isStaleBaselineError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === STALE_BASELINE_SQLSTATE;
}

/**
 * Reconciles every account with a matching, non-null-balance entry in
 * one fetched Plaid balance observation. Each account is a fully
 * independent state machine: fetch its actual latest snapshot, compute
 * the reconciliation event via the pure reconcileAccountBalance, persist
 * it atomically, and on the ONE recognized concurrency error
 * (isStaleBaselineError) retry exactly once — re-fetching the now-actual
 * latest snapshot and recomputing against the SAME already-fetched
 * balance observation, never a new Plaid call. Any other persistence
 * error, including a second stale-baseline failure in immediate
 * succession, propagates immediately and is never silently swallowed.
 */
export async function runAccountBalanceReconciliation(
  params: RunAccountBalanceReconciliationParams
): Promise<{ snapshots: AccountBalanceSnapshot[]; offsets: ReconciliationOffset[] }> {
  const {
    accounts,
    fetchBalances,
    syncCursor,
    getLatestSnapshot,
    loadTransactionsForAccount,
    persistReconciliationEvent,
    timezone,
    generateObservationId = () => crypto.randomUUID(),
  } = params;

  const observation = await fetchBalances();
  const balanceByPlaidAccountId = new Map(observation.balances.map((b) => [b.plaidAccountId, b.currentBalance]));
  const localDate = localCalendarDate(new Date(observation.observedAt), timezone);

  const snapshots: AccountBalanceSnapshot[] = [];
  const offsets: ReconciliationOffset[] = [];

  for (const account of accounts) {
    if (account.plaidAccountId === undefined) continue;
    const confirmedBalance = balanceByPlaidAccountId.get(account.plaidAccountId);
    if (confirmedBalance === undefined || confirmedBalance === null) continue;

    const transactionsForAccount = await loadTransactionsForAccount(account.id);
    const balanceObservationId = generateObservationId();

    const computeEvent = (priorSnapshot: AccountBalanceSnapshot | undefined): ReconciliationEvent => {
      const { snapshot, offset } = reconcileAccountBalance({
        account,
        priorSnapshot,
        confirmedBalance,
        observedAt: observation.observedAt,
        syncCursor,
        balanceObservationId,
        transactionsForAccount,
      });
      return { snapshot, offset, localDate };
    };

    const priorSnapshot = await getLatestSnapshot(account.id);
    let event = computeEvent(priorSnapshot);

    try {
      await persistReconciliationEvent(event);
    } catch (err) {
      if (!isStaleBaselineError(err)) throw err;

      const actualPriorSnapshot = await getLatestSnapshot(account.id);
      event = computeEvent(actualPriorSnapshot);
      await persistReconciliationEvent(event); // a second stale-baseline failure here propagates untouched
    }

    snapshots.push(event.snapshot);
    if (event.offset) offsets.push(event.offset);
  }

  return { snapshots, offsets };
}
