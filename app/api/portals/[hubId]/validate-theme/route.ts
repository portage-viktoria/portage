/**
 * Theme validation route.
 *
 * POST /api/portals/[hubId]/validate-theme
 * Body: { path: string }
 *
 * The user pastes a theme folder path (e.g. "@marketplace/Stuff_Matters_Inc_/Focus",
 * "MyCustomTheme", "Acme/child-theme"). We normalize it, try to fetch
 * `<path>/theme.json`, and return either the theme's metadata or a clear error.
 *
 * This replaces the old automatic-discovery approach. See the conversation log
 * for why: the Source Code API metadata endpoint doesn't support root-level
 * listing, so we ask the user where their theme lives instead.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/portal-connections";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

type ThemeJson = {
  label?: string;
  preview_path?: string;
  screenshot_path?: string;
  author?: string;
  version?: string;
  description?: string;
};

type ValidationSuccess = {
  ok: true;
  path: string;
  label: string;
  author?: string;
  version?: string;
  description?: string;
  source: "marketplace" | "nested" | "custom";
};

type ValidationFailure = {
  ok: false;
  error: string;
  hint?: string;
};

/**
 * Normalize whatever the user pasted into a clean theme path:
 * - Trim whitespace
 * - Strip leading/trailing slashes
 * - Collapse multiple slashes into one
 * - Reject obviously invalid paths early
 */
function normalizePath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "Theme path is required" };
  }

  let path = raw.trim();
  if (path.length === 0) {
    return { ok: false, error: "Theme path cannot be empty" };
  }

  // Strip leading/trailing slashes
  path = path.replace(/^\/+/, "").replace(/\/+$/, "");

  // Collapse duplicate slashes
  path = path.replace(/\/{2,}/g, "/");

  // Reject paths with invalid characters
  if (/[\s<>"'`]/.test(path)) {
    return { ok: false, error: "Theme path contains invalid characters" };
  }

  // Reject path traversal attempts
  if (path.includes("..")) {
    return { ok: false, error: "Theme path cannot contain '..'" };
  }

  if (path.length === 0) {
    return { ok: false, error: "Theme path cannot be empty after normalization" };
  }

  return { ok: true, path };
}

function classifyThemeSource(path: string): "marketplace" | "nested" | "custom" {
  if (path.startsWith("@marketplace/")) return "marketplace";
  if (path.includes("/")) return "nested";
  return "custom";
}

async function fetchThemeJson(
  accessToken: string,
  themePath: string
): Promise<{ status: number; body: ThemeJson | null }> {
  const encodedPath = themePath.split("/").map(encodeURIComponent).join("/");
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/content/${encodedPath}/theme.json`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/octet-stream",
    },
  });

  if (!res.ok) {
    return { status: res.status, body: null };
  }

  try {
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: null };
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ hubId: string }> }
) {
  const { hubId } = await params;
  const hubIdNum = parseInt(hubId, 10);

  if (isNaN(hubIdNum)) {
    const failure: ValidationFailure = { ok: false, error: "Invalid portal ID" };
    return NextResponse.json(failure, { status: 400 });
  }

  let payload: { path?: string };
  try {
    payload = await request.json();
  } catch {
    const failure: ValidationFailure = { ok: false, error: "Invalid request body" };
    return NextResponse.json(failure, { status: 400 });
  }

  const normalized = normalizePath(payload.path ?? "");
  if (!normalized.ok) {
    const failure: ValidationFailure = { ok: false, error: normalized.error };
    return NextResponse.json(failure, { status: 400 });
  }
  const themePath = normalized.path;

  // During this milestone connections are stored with null user_id.
  const userId: string | null = null;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(userId, hubIdNum);
  } catch (err) {
    console.error("[validate-theme] failed to get access token:", err);
    const failure: ValidationFailure = {
      ok: false,
      error: "This portal isn't connected to Portage yet.",
    };
    return NextResponse.json(failure, { status: 404 });
  }

  const { status, body } = await fetchThemeJson(accessToken, themePath);

  if (status === 404 || !body) {
    const failure: ValidationFailure = {
      ok: false,
      error: "No theme.json found at that path.",
      hint: "Double-check the folder in HubSpot's Design Manager. Paths are case-sensitive.",
    };
    return NextResponse.json(failure, { status: 404 });
  }

  if (status >= 400) {
    console.error(`[validate-theme] unexpected HubSpot status ${status} for path ${themePath}`);
    const failure: ValidationFailure = {
      ok: false,
      error: "HubSpot returned an error while checking this path. Try again in a moment.",
    };
    return NextResponse.json(failure, { status: 502 });
  }

  const success: ValidationSuccess = {
    ok: true,
    path: themePath,
    label: body.label ?? themePath.split("/").pop() ?? themePath,
    author: body.author,
    version: body.version,
    description: body.description,
    source: classifyThemeSource(themePath),
  };

  return NextResponse.json(success);
}