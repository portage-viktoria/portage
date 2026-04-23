/**
 * HubSpot OAuth helpers.
 *
 * Covers:
 * - Building the authorization URL the user is redirected to
 * - Exchanging an authorization code for tokens
 * - Refreshing access tokens when they expire
 * - Fetching basic portal metadata after a successful connection
 *
 * None of these functions touch the database directly — storage is the
 * caller's responsibility. This module is the pure HubSpot client.
 */

const HUBSPOT_AUTH_URL = "https://app.hubspot.com/oauth/authorize";
const HUBSPOT_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";
const HUBSPOT_API_BASE = "https://api.hubapi.com";

const REQUIRED_SCOPES = ["content", "files", "oauth"];

export type HubSpotTokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: "bearer";
};

export type HubSpotPortalInfo = {
  hub_id: number;
  hub_domain: string;
  user_id: number;
  app_id: number;
  expires_in: number;
  user: string;
  scopes: string[];
};

/**
 * Build the URL the user is redirected to in order to start the OAuth flow.
 */
export function buildAuthorizationUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.HUBSPOT_CLIENT_ID!,
    redirect_uri: process.env.HUBSPOT_REDIRECT_URI!,
    scope: REQUIRED_SCOPES.join(" "),
    state,
  });
  return `${HUBSPOT_AUTH_URL}?${params.toString()}`;
}

/**
 * Exchange the authorization code received on the callback for access + refresh tokens.
 */
export async function exchangeCodeForTokens(
  code: string
): Promise<HubSpotTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: process.env.HUBSPOT_CLIENT_ID!,
    client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
    redirect_uri: process.env.HUBSPOT_REDIRECT_URI!,
    code,
  });

  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HubSpot token exchange failed (${response.status}): ${errorText}`
    );
  }

  return response.json();
}

/**
 * Use a refresh token to get a new access token.
 * Called whenever the cached access token is expired or missing.
 */
export async function refreshAccessToken(
  refreshToken: string
): Promise<HubSpotTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: process.env.HUBSPOT_CLIENT_ID!,
    client_secret: process.env.HUBSPOT_CLIENT_SECRET!,
    refresh_token: refreshToken,
  });

  const response = await fetch(HUBSPOT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HubSpot token refresh failed (${response.status}): ${errorText}`
    );
  }

  return response.json();
}

/**
 * Fetch portal metadata using an access token.
 * Used right after the first token exchange to learn which portal we connected to.
 */
export async function fetchPortalInfo(
  accessToken: string
): Promise<HubSpotPortalInfo> {
  const response = await fetch(
    `${HUBSPOT_API_BASE}/oauth/v1/access-tokens/${accessToken}`,
    { method: "GET" }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `HubSpot portal info fetch failed (${response.status}): ${errorText}`
    );
  }

  return response.json();
}