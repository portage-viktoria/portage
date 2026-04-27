/**
 * Projects API — v2.
 *
 * Adds path normalization: leading/trailing slashes are stripped from
 * themePath before storage. This prevents bugs where templatePath becomes
 * something like "/Focus-child/templates/migration.html" — HubSpot rejects
 * paths with leading slashes silently, causing pages to be created without
 * a template association.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/portal-connections";
import { indexTheme } from "@/lib/module-indexer";
import { logAudit } from "@/lib/audit";

function cleanThemePath(raw: string): string {
  return raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, hub_id, theme_path, theme_label, name, created_at, updated_at")
    .is("archived_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[projects GET] db error:", error);
    return NextResponse.json({ ok: false, error: "Database error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, projects: data ?? [] });
}

export async function POST(request: NextRequest) {
  let body: { hubId?: unknown; themePath?: unknown; name?: unknown; themeLabel?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const hubId =
    typeof body.hubId === "number"
      ? body.hubId
      : typeof body.hubId === "string"
        ? parseInt(body.hubId, 10)
        : NaN;

  if (!Number.isInteger(hubId)) {
    return NextResponse.json({ ok: false, error: "hubId is required" }, { status: 400 });
  }

  // Normalize the theme path: strip leading/trailing slashes
  const rawThemePath =
    typeof body.themePath === "string" && body.themePath.trim().length > 0
      ? body.themePath.trim()
      : null;
  if (!rawThemePath) {
    return NextResponse.json({ ok: false, error: "themePath is required" }, { status: 400 });
  }
  const themePath = cleanThemePath(rawThemePath);
  if (themePath.length === 0) {
    return NextResponse.json({ ok: false, error: "themePath is invalid" }, { status: 400 });
  }

  const name =
    typeof body.name === "string" && body.name.trim().length > 0 ? body.name.trim() : null;
  if (!name) {
    return NextResponse.json({ ok: false, error: "name is required" }, { status: 400 });
  }

  const themeLabel =
    typeof body.themeLabel === "string" && body.themeLabel.trim().length > 0
      ? body.themeLabel.trim()
      : null;

  const supabase = createServiceClient();

  // Step 1: index the theme if not already indexed
  const { data: existingIndex } = await supabase
    .from("theme_indexes")
    .select("id, module_count")
    .eq("hub_id", hubId)
    .eq("theme_path", themePath)
    .maybeSingle();

  if (!existingIndex) {
    let accessToken: string;
    try {
      accessToken = await getAccessToken(null, hubId);
    } catch (err) {
      console.error("[projects POST] no access token for indexing:", err);
      return NextResponse.json(
        {
          ok: false,
          error: "This portal isn't connected to Portage yet. Connect it first.",
        },
        { status: 400 }
      );
    }

    let indexResult;
    try {
      indexResult = await indexTheme(accessToken, themePath);
    } catch (err) {
      console.error("[projects POST] indexer crashed:", err);
      return NextResponse.json(
        {
          ok: false,
          error:
            "Couldn't index the theme's modules. Verify the theme path is correct.",
        },
        { status: 500 }
      );
    }

    if (indexResult.moduleCount === 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "The theme has no readable modules in its /modules folder. " +
            "If this is a child theme of a marketplace theme, you may need to " +
            "clone the parent's modules into the child theme first.",
        },
        { status: 400 }
      );
    }

    const { error: cacheError } = await supabase.from("theme_indexes").upsert(
      {
        hub_id: hubId,
        theme_path: themePath,
        modules_json: indexResult,
        module_count: indexResult.moduleCount,
        indexed_at: indexResult.scannedAt,
      },
      { onConflict: "hub_id,theme_path" }
    );

    if (cacheError) {
      console.error("[projects POST] failed to cache index:", cacheError);
    }
  }

  // Step 2: create the project (with cleaned theme path)
  const { data, error } = await supabase
    .from("projects")
    .insert({
      hub_id: hubId,
      theme_path: themePath,
      theme_label: themeLabel,
      name,
    })
    .select()
    .single();

  if (error) {
    console.error("[projects POST] db error:", error);
    return NextResponse.json(
      { ok: false, error: `Failed to create project: ${error.message}` },
      { status: 500 }
    );
  }

  await logAudit({
    userId: null,
    hubId,
    action: "migration.started",
    resourceType: "project",
    resourceId: data.id,
    metadata: { theme_path: themePath, name },
  });

  return NextResponse.json({ ok: true, project: data });
}