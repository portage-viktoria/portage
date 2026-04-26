/**
 * Single page operations.
 *
 * GET /api/projects/[projectId]/pages/[pageId]
 *   Returns the full page record including parsed_json and classifications.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId, pageId } = await params;
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .from("migration_pages")
    .select("*")
    .eq("project_id", projectId)
    .eq("id", pageId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: "Database error" }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ ok: false, error: "Page not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, page: data });
}