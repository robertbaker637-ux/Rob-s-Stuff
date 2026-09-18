// /transactions/sync pagination + cursor safety (rv2.4).
//
// Kept separate from src/lib/domain/plaidSync.ts: that module stays
// pure/synchronous (its existing convention), while this one is
// inherently async I/O orchestration. It's still fully unit-testable by
// taking an INJECTED page-fetcher rather than calling the Plaid SDK
// directly — the real route handler supplies a fetcher backed by
// plaidClient.transactionsSync; tests supply a mock.

import { syncPlaidTransactions } from "@/lib/domain/plaidSync";
import type { MerchantRule, PlaidSyncBatch, PlaidTransactionData, SyncResult, Transaction } from "@/lib/domain/types";

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
