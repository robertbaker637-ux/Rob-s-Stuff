// Exchanges a Link public_token for an access_token, persists the new
// Item + its accounts + liabilities, then runs the initial
// /transactions/sync (Plaid's recommended pattern: call sync once right
// after Item creation so cursor-based sync is live before the first
// webhook even arrives).
//
// access_token is held in a local variable only long enough to pass to
// insertPlaidItem and createPlaidFetchPage — it is never assigned into
// any object that gets logged or returned from this route. The JSON
// response below is built field-by-field from safe values only.

import { NextRequest, NextResponse } from "next/server";
import { plaidClient } from "@/lib/plaid/client";
import { sanitizePlaidError } from "@/lib/plaid/errors";
import { createPlaidFetchPage, mapLiabilitiesResponseToLiabilityData } from "@/lib/plaid/syncAdapters";
import { runPlaidTransactionsSync } from "@/lib/plaid/syncOrchestration";
import {
  insertPlaidItem,
  loadMerchantRules,
  persistAccounts,
  persistDebts,
  persistTransactions,
  updateItemCursor,
} from "@/lib/plaid/persistence";
import { syncPlaidAccounts, syncPlaidLiabilities } from "@/lib/domain/plaidSync";
import type { PlaidAccountData } from "@/lib/domain/types";

export async function POST(request: NextRequest) {
  const { publicToken, userId } = await request.json();
  if (!publicToken || !userId) {
    return NextResponse.json({ error: "publicToken and userId are required" }, { status: 400 });
  }

  let accessToken: string;
  let plaidItemId: string;
  let institutionName: string | undefined;
  try {
    const exchangeResponse = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    accessToken = exchangeResponse.data.access_token;
    plaidItemId = exchangeResponse.data.item_id;
  } catch (err) {
    const sanitized = sanitizePlaidError(err);
    console.error("Plaid exchange-public-token failed:", sanitized);
    return NextResponse.json({ error: sanitized.message }, { status: 502 });
  }

  try {
    const item = await insertPlaidItem(userId, plaidItemId, accessToken, institutionName);

    // Accounts: create-or-update by plaidAccountId, then build the
    // Plaid-account-id -> our-account-id map the transaction sync needs.
    const balanceResponse = await plaidClient.accountsBalanceGet({ access_token: accessToken });
    const plaidAccounts: PlaidAccountData[] = balanceResponse.data.accounts.map((a) => ({
      plaidAccountId: a.account_id,
      name: a.name,
      type: a.type,
      subtype: a.subtype ?? undefined,
    }));
    const accounts = syncPlaidAccounts([], item.plaidItemId, plaidAccounts);
    await persistAccounts(userId, accounts);
    const accountIdByPlaidAccountId = new Map(accounts.map((a) => [a.plaidAccountId!, a.id]));

    // Liabilities: credit cards, mortgages, and student loans, via the
    // one adapter allowed to know Plaid's real liability shapes
    // (mapLiabilitiesResponseToLiabilityData). A credit-card or
    // student-loan record with a null account_id is skipped rather than
    // given a synthesized identity — logged as a count/kind only, never
    // the raw Plaid payload.
    try {
      const liabilitiesResponse = await plaidClient.liabilitiesGet({ access_token: accessToken });
      const { liabilities, skipped } = mapLiabilitiesResponseToLiabilityData(liabilitiesResponse.data);
      if (skipped.length > 0) {
        console.warn(
          "Plaid liabilities with missing account_id skipped:",
          skipped.map((s) => s.kind)
        );
      }
      if (liabilities.length > 0) {
        const debts = syncPlaidLiabilities([], liabilities);
        await persistDebts(userId, debts);
      }
    } catch (liabilityErr) {
      // Liabilities are best-effort — not every linked account has any,
      // and failure here must never block account/transaction ingestion.
      console.warn("Plaid liabilities fetch skipped:", sanitizePlaidError(liabilityErr).message);
    }

    // Initial transactions sync, same orchestration used for every
    // later sync (webhook-driven or manual) — no separate code path.
    // Loads the user's existing merchant rules so a known merchant
    // arriving during the first import is categorized on arrival rather
    // than landing in the review queue.
    const merchantRules = await loadMerchantRules(userId);
    const { syncResult, newCursor } = await runPlaidTransactionsSync({
      fetchPage: createPlaidFetchPage(accessToken),
      startingCursor: "",
      localTransactions: [],
      accountIdByPlaidAccountId,
      merchantRules,
      persistTransactions: (transactions) => persistTransactions(userId, transactions),
    });
    await updateItemCursor(item.id, newCursor);

    return NextResponse.json({
      itemId: item.id,
      status: item.status,
      accountsLinked: accounts.length,
      transactionsCreated: syncResult.created,
    });
  } catch (err) {
    const sanitized = sanitizePlaidError(err);
    console.error("Plaid Item setup failed:", sanitized);
    return NextResponse.json({ error: sanitized.message }, { status: 502 });
  }
}
