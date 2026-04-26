/**
 * Theme indexing route.
 *
 * POST /api/portals/[hubId]/index-theme
 * Body: { path: string }
 *
 * Triggers a fresh scan of the given theme's modules folder. Stores the
 * resulting catalog in the theme_indexes table and returns it.
 *
 * Re-running this endpoint replaces the cached catalog — useful when the
 * user has added or modified modules in the theme.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/portal-connections";
import { indexTheme } from "@/lib/module-indexer";
import { createServiceClient } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";

function normalizePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let path = raw.trim();
  if (path.length === 0) return null;
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\/{2,}/g, "/");
  if (/[\s<>"'`]/.test(path)) return null;
  if (path.includes("..")) return null;
  return path.length > 0 ? path : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ hubId: string }> }
) {
  const { hubId } = await params;
  const hubIdNum = parseInt(hubId, 10);
  if (isNaN(hubIdNum)) {
    return NextResponse.json({ ok: false, error: "Invalid portal ID" }, { status: 400 });
  }

  let payload: { path?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const themePath = normalizePath(payload.path);
  if (!themePath) {
    return NextResponse.json({ ok: false, error: "Invalid theme path" }, { status: 400 });
  }

  const userId: string | null = null;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(userId, hubIdNum);
  } catch (err) {
    console.error("[index-theme] no access token:", err);
    return NextResponse.json(
      { ok: false, error: "Portal not connected." },
      { status: 404 }
    );
  }

  let result;
  try {
    result = await indexTheme(accessToken, themePath);
  } catch (err) {
    console.error("[index-theme] indexer crashed:", err);
    return NextResponse.json(
      { ok: false, error: "Indexer failed. Try again in a moment." },
      { status: 500 }
    );
  }

  // Cache the result. Use upsert so a re-index replaces the prior catalog.
  const supabase = createServiceClient();
  const { error: dbError } = await supabase
    .from("theme_indexes")
    .upsert(
      {
        hub_id: hubIdNum,
        theme_path: themePath,
        modules_json: result,
        module_count: result.moduleCount,
        indexed_at: result.scannedAt,
      },
      { onConflict: "hub_id,theme_path" }
    );

  if (dbError) {
    console.error("[index-theme] failed to cache:", dbError);
    // Don't fail the request — return the catalog even if caching failed,
    // so the user still gets their result.
  }

  await logAudit({
    userId,
    hubId: hubIdNum,
    action: "theme.indexed",
    resourceType: "theme",
    resourceId: themePath,
    metadata: {
      module_count: result.moduleCount,
      warning_count: result.warnings.length,
    },
  });

  return NextResponse.json({ ok: true, ...result });
}

/**
 * GET /api/portals/[hubId]/index-theme?path=...
 *
 * Returns the cached catalog if one exists. Used by the UI to load a previously
 * indexed catalog without re-scanning.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hubId: string }> }
) {
  const { hubId } = await params;
  const hubIdNum = parseInt(hubId, 10);
  if (isNaN(hubIdNum)) {
    return NextResponse.json({ ok: false, error: "Invalid portal ID" }, { status: 400 });
  }

  const themePath = normalizePath(request.nextUrl.searchParams.get("path"));
  if (!themePath) {
    return NextResponse.json({ ok: false, error: "Invalid theme path" }, { status: 400 });
  }

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("theme_indexes")
    .select("modules_json, indexed_at")
    .eq("hub_id", hubIdNum)
    .eq("theme_path", themePath)
    .maybeSingle();

  if (error) {
    console.error("[index-theme GET] db error:", error);
    return NextResponse.json({ ok: false, error: "Database error" }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ ok: false, cached: false }, { status: 404 });
  }

  return NextResponse.json({ ok: true, cached: true, ...data.modules_json });
}