/**
 * Projects API — v3 (Patch B).
 *
 * Removes the theme indexing step. Indexing is no longer needed since
 * Patch B replaced dynamic theme introspection with the reference catalog.
 *
 * Adds: theme_name, template_name, status columns to the insert.
 *
 * Keeps:
 *   - Path normalization (cleanThemePath)
 *   - Theme path validation
 *   - Soft-archive filter on GET (archived_at is null)
 *   - Audit log on create
 *   - The same response shapes the UI expects
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";

const DEFAULT_THEME_NAME = "Bluleadz Starter Theme - LP v2";
const DEFAULT_TEMPLATE_NAME = "migration.html";

function cleanThemePath(raw: string): string {
  return raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

export async function GET() {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("projects")
    .select(
      "id, hub_id, theme_path, theme_label, theme_name, template_name, name, status, created_at, updated_at"
    )
    .is("archived_at", null)
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[projects GET] db error:", error);
    return NextResponse.json({ ok: false, error: "Database error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, projects: data ?? [] });
}

export async function POST(request: NextRequest) {
  let body: {
    hubId?: unknown;
    themePath?: unknown;
    name?: unknown;
    themeLabel?: unknown;
    themeName?: unknown;
    templateName?: unknown;
  };
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

  const themeName =
    typeof body.themeName === "string" && body.themeName.trim().length > 0
      ? body.themeName.trim()
      : DEFAULT_THEME_NAME;

  const templateName =
    typeof body.templateName === "string" && body.templateName.trim().length > 0
      ? body.templateName.trim()
      : DEFAULT_TEMPLATE_NAME;

  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("projects")
    .insert({
      hub_id: hubId,
      theme_path: themePath,
      theme_label: themeLabel,
      theme_name: themeName,
      template_name: templateName,
      name,
      status: "not_started",
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
    metadata: { theme_path: themePath, theme_name: themeName, name },
  });

  return NextResponse.json({ ok: true, project: data });
}