/**
 * OAuth start route.
 *
 * Hit this when the user clicks "Connect HubSpot Portal" in the Portage UI.
 * It generates a signed state token (for CSRF protection), stores it in the
 * database with a 10-minute expiry, and redirects the user to HubSpot.
 *
 * The callback route verifies the state before exchanging the code for tokens.
 */

import { NextRequest, NextResponse } from "next/server";
import { buildAuthorizationUrl } from "@/lib/hubspot-oauth";
import { generateStateToken } from "@/lib/crypto";
import { createServiceClient } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  // TODO: once we add Supabase Auth, resolve the real user_id from the session.
  // For now, during first-integration testing, we allow an anonymous state row.
  const userId: string | null = null;

  const state = generateStateToken();
  const supabase = createServiceClient();

  const { error } = await supabase.from("oauth_states").insert({
    state,
    user_id: userId,
  });

  if (error) {
    console.error("[oauth/start] failed to store state:", error);
    return NextResponse.json(
      { error: "Failed to start OAuth flow" },
      { status: 500 }
    );
  }

  const authUrl = buildAuthorizationUrl(state);
  return NextResponse.redirect(authUrl);
}