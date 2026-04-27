/**
 * Staging availability check.
 *
 * GET /api/projects/[projectId]/pages/[pageId]/staging-check
 *
 * Returns { stagingAvailable: boolean }. Used by the publish dialog to
 * disable the staging option for portals on Starter tier.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/portal-connections";
import { detectStagingAvailable } from "@/lib/hubspot-publish";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId } = await params;
  const supabase = createServiceClient();

  const { data: project, error } = await supabase
    .from("projects")
    .select("hub_id")
    .eq("id", projectId)
    .maybeSingle();

  if (error || !project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(null, project.hub_id);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Portal not connected" },
      { status: 404 }
    );
  }

  const stagingAvailable = await detectStagingAvailable(accessToken);

  return NextResponse.json({ ok: true, stagingAvailable });
}