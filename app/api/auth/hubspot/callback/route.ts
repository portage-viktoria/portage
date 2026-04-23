/**
 * OAuth callback route.
 *
 * HubSpot redirects the user here after they approve (or deny) the install.
 *
 * Security steps, in order:
 * 1. Verify the `state` parameter against what we stored in the database
 * 2. Confirm it hasn't expired and hasn't already been consumed
 * 3. Mark it consumed (single-use)
 * 4. Exchange the `code` for tokens
 * 5. Fetch portal metadata (so we know the hub_id and domain)
 * 6. Encrypt and store the connection
 * 7. Redirect the user back to the Portage UI with a success state
 *
 * Any failure in steps 1–3 is a CSRF attempt or a stale flow; reject with 400.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCodeForTokens,
  fetchPortalInfo,
} from "@/lib/hubspot-oauth";
import { storeConnection } from "@/lib/portal-connections";
import { createServiceClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // HubSpot sent us an error (user denied, etc.)
  if (error) {
    return NextResponse.redirect(
      new URL(`/?connect_error=${encodeURIComponent(error)}`, request.url)
    );
  }

  if (!code || !state) {
    return NextResponse.json(
      { error: "Missing code or state parameter" },
      { status: 400 }
    );
  }

  // Step 1–3: verify and consume state
  const supabase = createServiceClient();
  const { data: stateRow, error: stateErr } = await supabase
    .from("oauth_states")
    .select("state, user_id, expires_at, consumed_at")
    .eq("state", state)
    .single();

  if (stateErr || !stateRow) {
    return NextResponse.json(
      { error: "Invalid or expired state token" },
      { status: 400 }
    );
  }

  if (stateRow.consumed_at) {
    return NextResponse.json(
      { error: "State token already used" },
      { status: 400 }
    );
  }

  if (new Date(stateRow.expires_at) < new Date()) {
    return NextResponse.json(
      { error: "State token expired" },
      { status: 400 }
    );
  }

  // Mark as consumed immediately to prevent replay
  await supabase
    .from("oauth_states")
    .update({ consumed_at: new Date().toISOString() })
    .eq("state", state);

  // Step 4–5: exchange code, learn which portal we connected to
  let tokens;
  let portalInfo;
  try {
    tokens = await exchangeCodeForTokens(code);
    portalInfo = await fetchPortalInfo(tokens.access_token);
  } catch (err) {
    console.error("[oauth/callback] token exchange failed:", err);
    return NextResponse.redirect(
      new URL(`/?connect_error=token_exchange_failed`, request.url)
    );
  }

  // Step 6: store connection
  // NOTE: stateRow.user_id is null during first-integration testing.
  // Once Supabase Auth is wired up, this will be the real authenticated user.
  try {
    await storeConnection({
      userId: stateRow.user_id ?? "00000000-0000-0000-0000-000000000000",
      hubId: portalInfo.hub_id,
      portalDomain: portalInfo.hub_domain,
      refreshToken: tokens.refresh_token,
      scopes: portalInfo.scopes,
    });
  } catch (err) {
    console.error("[oauth/callback] failed to store connection:", err);
    return NextResponse.redirect(
      new URL(`/?connect_error=storage_failed`, request.url)
    );
  }

  // Step 7: back to the UI with the hub_id so we can show a success state
  return NextResponse.redirect(
    new URL(`/?connected=${portalInfo.hub_id}`, request.url)
  );
}