// Service-role Supabase client. Bypasses RLS entirely — this is the ONLY
// client allowed to touch plaid_items (whose access_token column has no
// RLS policy granting access to anything else, by design; see
// supabase/migrations/0001_init.sql). Server-only: never import this
// from anything under src/components, and never forward its query
// results directly into a route handler's JSON response without
// stripping access_token first (see src/lib/plaid/syncOrchestration.ts).
//
// Inert until SUPABASE_SERVICE_ROLE_KEY/NEXT_PUBLIC_SUPABASE_URL are set
// (see .env.example) — same treatment as client.ts/server.ts in rv2.1.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

export function createServiceRoleClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
