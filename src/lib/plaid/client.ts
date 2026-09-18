// Server-only Plaid client. Inert until PLAID_CLIENT_ID/PLAID_SECRET are
// set (see .env.example) — there is no live Plaid project this pass, so
// this is never exercised, same treatment as src/lib/supabase/client.ts
// was in rv2.1.
//
// Never import this from anything under src/components — it reads
// server-only env vars and every call it makes is capable of touching a
// stored access token (see serviceRole.ts).

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

const environment = (process.env.PLAID_ENV ?? "sandbox") as keyof typeof PlaidEnvironments;

const configuration = new Configuration({
  basePath: PlaidEnvironments[environment],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

export const plaidClient = new PlaidApi(configuration);
