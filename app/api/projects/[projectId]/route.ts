/**
 * Single project API.
 *
 * GET /api/projects/[projectId]
 *   Returns the project + its pages list.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  const supabase = createServiceClient();

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError) {
    return NextResponse.json({ ok: false, error: "Database error" }, { status: 500 });
  }
  if (!project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  const { data: pages, error: pagesError } = await supabase
    .from("migration_pages")
    .select(
      "id, source_url, page_title, page_description, status, status_message, " +
        "section_count, hubspot_page_url, created_at, updated_at"
    )
    .eq("project_id", projectId)
    .order("updated_at", { ascending: false });

  if (pagesError) {
    return NextResponse.json({ ok: false, error: "Database error" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, project, pages: pages ?? [] });
}