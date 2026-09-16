// Browser-side Supabase client. Inert until NEXT_PUBLIC_SUPABASE_URL and
// NEXT_PUBLIC_SUPABASE_ANON_KEY are set (see .env.example) — not called
// from any page in this pass, since there's no live project to connect to
// yet. Present now so the auth foundation doesn't need a later rebuild.

import { createBrowserClient } from "@supabase/ssr";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
