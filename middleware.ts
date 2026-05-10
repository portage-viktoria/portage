/**
 * Middleware — gates every route except /login and static assets.
 *
 * Reads the Supabase session from cookies. Redirects unauthenticated users
 * to /login. Refreshes the session token on every request (Supabase requires
 * this to keep tokens fresh).
 *
 * Place this file at the project root (same level as package.json), NOT
 * inside the app/ directory.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseMiddlewareClient } from "@/lib/auth";

// Routes that don't require authentication
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  // OAuth callback from HubSpot must be reachable without our session
  "/api/auth/hubspot/callback",
  "/api/auth/hubspot/start",
];

// Asset paths that should always pass through
function isStaticAsset(pathname: string): boolean {
  return (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/favicon") ||
    pathname.startsWith("/static/") ||
    /\.(svg|png|jpg|jpeg|gif|webp|ico|css|js|map)$/i.test(pathname)
  );
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths and static assets through
  if (isStaticAsset(pathname)) return NextResponse.next();
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  // Check session
  const { supabase, response } = createSupabaseMiddlewareClient(request);
  const { data, error } = await supabase.auth.getUser();

  if (error || !data.user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    // Run on every path except the ones we explicitly skip
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};