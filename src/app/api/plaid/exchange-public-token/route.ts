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
import { createPlaidFetchPage } from "@/lib/plaid/syncAdapters";
import { runPlaidTransactionsSync } from "@/lib/plaid/syncOrchestration";
import {
  insertPlaidItem,
  persistAccounts,
  persistDebts,
  persistTransactions,
  updateItemCursor,
} from "@/lib/plaid/persistence";
import { syncPlaidAccounts, syncPlaidLiabilities } from "@/lib/domain/plaidSync";
import type { PlaidAccountData, PlaidLiabilityData } from "@/lib/domain/types";

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

    // Liabilities (credit-card shape only this pass — mortgage/student
    // loan liabilities have different fields and aren't modeled by our
    // Debt entity yet).
    try {
      const liabilitiesResponse = await plaidClient.liabilitiesGet({ access_token: accessToken });
      const balanceByAccountId = new Map(
        liabilitiesResponse.data.accounts.map((a) => [a.account_id, a.balances.current ?? 0])
      );
      const liabilities: PlaidLiabilityData[] = (liabilitiesResponse.data.liabilities.credit ?? [])
        .filter((l) => l.account_id)
        .map((l) => ({
          plaidLiabilityId: l.account_id!,
          currentBalance: balanceByAccountId.get(l.account_id!) ?? 0,
          apr: l.aprs[0]?.apr_percentage,
          minimumPaymentAmount: l.minimum_payment_amount ?? undefined,
          accountName: liabilitiesResponse.data.accounts.find((a) => a.account_id === l.account_id)?.name,
        }));
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
    const { syncResult, newCursor } = await runPlaidTransactionsSync({
      fetchPage: createPlaidFetchPage(accessToken),
      startingCursor: "",
      localTransactions: [],
      accountIdByPlaidAccountId,
      merchantRules: [], // TODO(rv2.5+): load the user's existing merchant rules
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
