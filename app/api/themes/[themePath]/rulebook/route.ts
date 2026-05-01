/**
 * Rulebook API for a theme.
 *
 * GET  /api/themes/[themePath]/rulebook?hub_id=...  → returns rulebook + catalog
 * PUT  /api/themes/[themePath]/rulebook              → saves rulebook
 *
 * Note: themePath is URL-encoded in the route (slashes become %2F).
 * The client must encode/decode it.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { loadRulebook, saveRulebook } from "@/lib/rulebook";
import { logAudit } from "@/lib/audit";

// Decode the theme path from URL params
function decodeThemePath(encoded: string): string {
  return decodeURIComponent(encoded);
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ themePath: string }> }
) {
  const { themePath: encodedThemePath } = await params;
  const themePath = decodeThemePath(encodedThemePath);

  const url = new URL(request.url);
  const hubIdParam = url.searchParams.get("hub_id");
  if (!hubIdParam) {
    return NextResponse.json({ ok: false, error: "Missing hub_id query param" }, { status: 400 });
  }
  const hubId = parseInt(hubIdParam, 10);
  if (isNaN(hubId)) {
    return NextResponse.json({ ok: false, error: "Invalid hub_id" }, { status: 400 });
  }

  const supabase = createServiceClient();

  // Load rulebook (may be null if none exists yet)
  const rulebook = await loadRulebook(hubId, themePath);

  // Load theme catalog so the editor can show available modules
  const { data: themeIndex } = await supabase
    .from("theme_indexes")
    .select("modules_json, scanned_at")
    .eq("hub_id", hubId)
    .eq("theme_path", themePath)
    .maybeSingle();

  if (!themeIndex) {
    return NextResponse.json({
      ok: false,
      error: "Theme not yet indexed. Connect a project to this theme first to index its modules.",
    }, { status: 404 });
  }

  type IndexedModule = {
    name?: unknown;
    label?: unknown;
    description?: unknown;
    path?: unknown;
    apiPath?: unknown;
    hasRepeater?: unknown;
    totalFields?: unknown;
    tags?: unknown;
  };

  const rawModules: IndexedModule[] =
    Array.isArray((themeIndex.modules_json as { modules?: unknown })?.modules)
      ? ((themeIndex.modules_json as { modules: IndexedModule[] }).modules)
      : [];

  const moduleSummaries = rawModules
    .filter((m): m is IndexedModule & { name: string } => typeof m.name === "string")
    .map((m) => ({
      name: m.name,
      label: typeof m.label === "string" ? m.label : m.name,
      description: typeof m.description === "string" ? m.description : undefined,
      hasRepeater: m.hasRepeater === true,
      totalFields: typeof m.totalFields === "number" ? m.totalFields : 0,
      tags: Array.isArray(m.tags) ? (m.tags as string[]) : [],
    }));

  return NextResponse.json({
    ok: true,
    rulebook,
    modules: moduleSummaries,
    scannedAt: themeIndex.scanned_at,
  });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ themePath: string }> }
) {
  const { themePath: encodedThemePath } = await params;
  const themePath = decodeThemePath(encodedThemePath);

  let body: { hub_id?: number; rules?: Record<string, string | null> };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.hub_id !== "number") {
    return NextResponse.json({ ok: false, error: "Missing or invalid hub_id" }, { status: 400 });
  }
  if (!body.rules || typeof body.rules !== "object") {
    return NextResponse.json({ ok: false, error: "Missing or invalid rules object" }, { status: 400 });
  }

  try {
    const saved = await saveRulebook(body.hub_id, themePath, body.rules);

    await logAudit({
      userId: null,
      hubId: body.hub_id,
      action: "theme.indexed",
      resourceType: "theme",
      resourceId: themePath,
      metadata: {
        step: "rulebook_saved",
        rule_count: Object.keys(body.rules).filter((k) => body.rules![k]).length,
      },
    });

    return NextResponse.json({ ok: true, rulebook: saved });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}