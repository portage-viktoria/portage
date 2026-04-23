/**
 * Supabase client factories.
 *
 * Two clients:
 * - `createBrowserClient()` — for client components; uses anon key, respects RLS.
 * - `createServiceClient()` — for server-side code only; uses service role key,
 *   bypasses RLS. Never import this into a client component.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

export function createBrowserClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}

export function createServiceClient(): SupabaseClient {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}