// Link token request construction (rv2.4).
//
// Pure function so it's testable without hitting Plaid — the route
// handler just passes this output straight to plaidClient.linkTokenCreate.
//
// Transactions history depth and the webhook URL are both fixed at the
// Item's INITIAL creation and can never be changed afterward (Plaid: "48
// Once Transactions has been added to an Item, this value cannot be
// updated") — so this is the one place that matters, not something to
// revisit post-hoc.

import { CountryCode, type LinkTokenCreateRequest, Products } from "plaid";

const HISTORICAL_DAYS_REQUESTED = 730; // ~24 months, per the brief — Plaid defaults to 90.

export interface BuildLinkTokenRequestParams {
  userId: string;
  clientName?: string;
}

export function buildLinkTokenRequest(params: BuildLinkTokenRequestParams): LinkTokenCreateRequest {
  return {
    client_name: params.clientName ?? "BASELINE",
    language: "en",
    country_codes: [CountryCode.Us],
    user: { client_user_id: params.userId },
    products: [Products.Transactions, Products.Liabilities],
    transactions: { days_requested: HISTORICAL_DAYS_REQUESTED },
    webhook: process.env.PLAID_WEBHOOK_URL,
  };
}
