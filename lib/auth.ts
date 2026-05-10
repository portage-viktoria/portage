/**
 * Auth helpers — server-side session checking via Supabase Auth.
 *
 * The session cookie is set by Supabase's auth client when the user logs in.
 * Server code can read it via createSupabaseServerClient and call getUser().
 *
 * Used by:
 *   - middleware.ts (route gating)
 *   - server components that need to know who's logged in
 *   - API routes that need to verify the request is authenticated
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * For use in server components and route handlers.
 * Reads/writes cookies via Next's cookies() API.
 */
export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          );
        } catch {
          // Server components can't set cookies — silently ignore.
          // The middleware handles cookie refresh.
        }
      },
    },
  });
}

/**
 * For use in middleware. Reads/writes cookies via the request and response.
 */
export function createSupabaseMiddlewareClient(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options as CookieOptions)
        );
      },
    },
  });

  return { supabase, response };
}

/**
 * Returns the current logged-in user, or null.
 * Use in server components.
 */
export async function getCurrentUser() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}