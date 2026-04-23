/**
 * Portal connection management.
 *
 * This module is the bridge between the database and the HubSpot OAuth client.
 * It handles:
 * - Storing new connections (encrypting refresh tokens before DB write)
 * - Retrieving a valid access token for a given hub_id (with in-memory caching)
 * - Refreshing expired tokens transparently
 *
 * Every HubSpot API call in Portage should go through `getAccessToken()`.
 * Never query portal_connections directly from feature code.
 */

import { createServiceClient } from "./supabase";
import { encrypt, decrypt } from "./crypto";
import { refreshAccessToken } from "./hubspot-oauth";
import { logAudit } from "./audit";

// In-memory cache: hub_id -> { token, expiresAt }
// Access tokens live 30 minutes on HubSpot's side; we cache for 25 minutes
// to leave a safety margin.
const tokenCache = new Map<number, { token: string; expiresAt: number }>();
const CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

export type StoreConnectionArgs = {
  userId: string | null;
  hubId: number;
  portalDomain: string;
  refreshToken: string;
  scopes: string[];
};

export async function storeConnection(args: StoreConnectionArgs): Promise<void> {
  const encrypted = encrypt(args.refreshToken);
  const supabase = createServiceClient();

  // Because user_id may be null during this milestone, we can't rely on the
  // combined-unique constraint for upserts. Instead, we manually delete any
  // existing connection for this hub_id + user_id pair and then insert fresh.
  // Once auth is wired up and the unique constraint is restored, this can go
  // back to a proper upsert.
  const deleteQuery = supabase.from("portal_connections").delete().eq("hub_id", args.hubId);
  if (args.userId === null) {
    await deleteQuery.is("user_id", null);
  } else {
    await deleteQuery.eq("user_id", args.userId);
  }

  const { error } = await supabase.from("portal_connections").insert({
    user_id: args.userId,
    hub_id: args.hubId,
    portal_domain: args.portalDomain,
    refresh_token_ciphertext: encrypted.ciphertext,
    refresh_token_iv: encrypted.iv,
    refresh_token_auth_tag: encrypted.authTag,
    scopes: args.scopes,
    connected_at: new Date().toISOString(),
    revoked_at: null,
  });

  if (error) {
    throw new Error(`Failed to store portal connection: ${error.message}`);
  }

  await logAudit({
    userId: args.userId,
    hubId: args.hubId,
    action: "portal.connected",
    metadata: { portal_domain: args.portalDomain, scopes: args.scopes },
  });
}

/**
 * Get a valid HubSpot access token for a portal.
 * Handles caching, decryption, and automatic refresh.
 */
export async function getAccessToken(
  userId: string | null,
  hubId: number
): Promise<string> {
  // Cache hit — return immediately if still valid
  const cached = tokenCache.get(hubId);
  if (cached && cached.expiresAt > Date.now() + CACHE_SAFETY_MARGIN_MS) {
    return cached.token;
  }

  // Cache miss — fetch connection and refresh
  const supabase = createServiceClient();
  let query = supabase
    .from("portal_connections")
    .select("refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag, user_id")
    .eq("hub_id", hubId)
    .is("revoked_at", null);

  if (userId === null) {
    query = query.is("user_id", null);
  } else {
    query = query.eq("user_id", userId);
  }

  const { data, error } = await query.single();

  if (error || !data) {
    throw new Error(`No active connection for hub_id ${hubId}`);
  }

  const refreshToken = decrypt({
    ciphertext: data.refresh_token_ciphertext,
    iv: data.refresh_token_iv,
    authTag: data.refresh_token_auth_tag,
  });

  const tokenResponse = await refreshAccessToken(refreshToken);

  // HubSpot may issue a new refresh token on refresh; if so, persist it.
  if (tokenResponse.refresh_token && tokenResponse.refresh_token !== refreshToken) {
    const newEncrypted = encrypt(tokenResponse.refresh_token);
    let updateQuery = supabase
      .from("portal_connections")
      .update({
        refresh_token_ciphertext: newEncrypted.ciphertext,
        refresh_token_iv: newEncrypted.iv,
        refresh_token_auth_tag: newEncrypted.authTag,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq("hub_id", hubId);

    if (userId === null) {
      updateQuery = updateQuery.is("user_id", null);
    } else {
      updateQuery = updateQuery.eq("user_id", userId);
    }

    await updateQuery;
  }

  const expiresAt = Date.now() + tokenResponse.expires_in * 1000;
  tokenCache.set(hubId, { token: tokenResponse.access_token, expiresAt });

  await logAudit({
    userId,
    hubId,
    action: "portal.refreshed",
  });

  return tokenResponse.access_token;
}