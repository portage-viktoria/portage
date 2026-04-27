/**
 * Single page operations.
 *
 * GET    /api/projects/[projectId]/pages/[pageId]
 *   Returns the full page record.
 *
 * DELETE /api/projects/[projectId]/pages/[pageId]
 *   Removes the page from Portage. Does NOT touch the published HubSpot page —
 *   if a HubSpot page exists, it stays, untouched. Lets the user re-add the
 *   same source URL later for a fresh migration without affecting their
 *   already-published HubSpot content.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";

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

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId, pageId } = await params;
  const supabase = createServiceClient();

  // Load to get the source_url for the audit log
  const { data: page } = await supabase
    .from("migration_pages")
    .select("source_url, status, hubspot_page_id, hubspot_page_url")
    .eq("project_id", projectId)
    .eq("id", pageId)
    .maybeSingle();

  if (!page) {
    return NextResponse.json({ ok: false, error: "Page not found" }, { status: 404 });
  }

  const { error: deleteError } = await supabase
    .from("migration_pages")
    .delete()
    .eq("project_id", projectId)
    .eq("id", pageId);

  if (deleteError) {
    return NextResponse.json(
      { ok: false, error: "Failed to delete page" },
      { status: 500 }
    );
  }

  await logAudit({
    userId: null,
    hubId: null,
    action: "page.deleted",
    resourceType: "page",
    resourceId: pageId,
    metadata: {
      source_url: page.source_url,
      previous_status: page.status,
      hubspot_page_id_kept: page.hubspot_page_id,
      reason: "user_deleted_from_portage_only",
    },
  });

  return NextResponse.json({
    ok: true,
    deleted: true,
    hubspotPageStillExists: !!page.hubspot_page_id,
    hubspotPageUrl: page.hubspot_page_url ?? null,
  });
}