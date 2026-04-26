/**
 * Projects API.
 *
 * GET  /api/projects              — list projects (active only)
 * POST /api/projects              — create a project
 *
 * Body for POST:
 *   {
 *     hubId: number,
 *     themePath: string,
 *     name: string,
 *     themeLabel?: string
 *   }
 *
 * The caller is expected to have validated the theme path before creating.
 * We don't re-validate here to keep this endpoint fast.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";

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

  const themePath =
    typeof body.themePath === "string" && body.themePath.trim().length > 0
      ? body.themePath.trim()
      : null;
  if (!themePath) {
    return NextResponse.json({ ok: false, error: "themePath is required" }, { status: 400 });
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