/**
 * Theme validation route.
 *
 * POST /api/portals/[hubId]/validate-theme
 * Body: { path: string }
 *
 * The user pastes a theme folder path. We normalize it, try to fetch
 * `<path>/theme.json`, and return either the theme's metadata or a clear error.
 *
 * Notes on theme.json quirks:
 *   - `author` may be a string ("Helpful Hero") OR an object ({ name, email }).
 *     We normalize either form into a single display string.
 *   - Other fields may be missing entirely. Every field we surface is optional
 *     except `label` and `path`.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/portal-connections";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

// theme.json is author's choice — we accept the shapes we've seen in the wild
type ThemeAuthor = string | { name?: string; email?: string; url?: string };

type ThemeJson = {
  label?: string;
  preview_path?: string;
  screenshot_path?: string;
  author?: ThemeAuthor;
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

function normalizePath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  if (typeof raw !== "string") {
    return { ok: false, error: "Theme path is required" };
  }

  let path = raw.trim();
  if (path.length === 0) {
    return { ok: false, error: "Theme path cannot be empty" };
  }

  path = path.replace(/^\/+/, "").replace(/\/+$/, "");
  path = path.replace(/\/{2,}/g, "/");

  if (/[\s<>"'`]/.test(path)) {
    return { ok: false, error: "Theme path contains invalid characters" };
  }

  if (path.includes("..")) {
    return { ok: false, error: "Theme path cannot contain '..'" };
  }

  if (path.length === 0) {
    return { ok: false, error: "Theme path cannot be empty after normalization" };
  }

  return { ok: true, path };
}

/**
 * Coerce an author field of any shape into a single display string, or
 * undefined if the field is empty/missing. This keeps the API contract simple
 * and guarantees the client never has to handle an object for this field.
 */
function normalizeAuthor(raw: ThemeAuthor | undefined): string | undefined {
  if (!raw) return undefined;

  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (typeof raw === "object") {
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length > 0) return name;

    const email = typeof raw.email === "string" ? raw.email.trim() : "";
    if (email.length > 0) return email;

    return undefined;
  }

  return undefined;
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

  // Build the success response. Every field except label + path + source is
  // optional — we only include fields that have real, non-empty values.
  const success: ValidationSuccess = {
    ok: true,
    path: themePath,
    label:
      typeof body.label === "string" && body.label.trim().length > 0
        ? body.label.trim()
        : themePath.split("/").pop() ?? themePath,
    source: classifyThemeSource(themePath),
  };

  const author = normalizeAuthor(body.author);
  if (author) success.author = author;

  if (typeof body.version === "string" && body.version.trim().length > 0) {
    success.version = body.version.trim();
  }

  if (typeof body.description === "string" && body.description.trim().length > 0) {
    success.description = body.description.trim();
  }

  return NextResponse.json(success);
}