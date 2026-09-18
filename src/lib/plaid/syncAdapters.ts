// Glue between the pure sync orchestration and the real Plaid SDK
// (rv2.4). This is the ONLY place an access token is read from and used
// — it's captured in this closure and never returned, logged, or stored
// anywhere else. See src/lib/plaid/errors.ts for how failures from these
// calls get sanitized before logging.

import type { Transaction as PlaidApiTransaction } from "plaid";
import { plaidClient } from "./client";
import type { FetchSyncPage, PlaidSyncPage } from "./syncOrchestration";
import type { PlaidTransactionData } from "@/lib/domain/types";

function toPlaidTransactionData(t: PlaidApiTransaction): PlaidTransactionData {
  return {
    transactionId: t.transaction_id,
    pendingTransactionId: t.pending_transaction_id ?? undefined,
    plaidAccountId: t.account_id,
    amount: t.amount,
    date: t.date,
    pending: t.pending,
    merchantName: t.merchant_name ?? undefined,
    name: t.name,
    category: t.category ?? undefined,
  };
}

/** Builds a FetchSyncPage bound to one Item's access token, for
 * fetchCompletePlaidSyncBatch/runPlaidTransactionsSync. The access token
 * lives only in this closure. */
export function createPlaidFetchPage(accessToken: string): FetchSyncPage {
  return async (cursor: string): Promise<PlaidSyncPage> => {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: cursor || undefined,
    });
    const data = response.data;
    return {
      added: data.added.map(toPlaidTransactionData),
      modified: data.modified.map(toPlaidTransactionData),
      removed: data.removed
        .filter((r) => r.transaction_id)
        .map((r) => ({ transactionId: r.transaction_id! })),
      nextCursor: data.next_cursor,
      hasMore: data.has_more,
    };
  };
}
