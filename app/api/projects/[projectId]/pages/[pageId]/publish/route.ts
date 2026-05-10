/**
 * Verify portal endpoint.
 *
 * GET  /api/projects/[projectId]/verify-portal   — returns cached or fresh result
 * POST /api/projects/[projectId]/verify-portal   — forces re-verification
 *
 * Checks that all catalog modules exist in the connected portal's theme.
 * Result is cached in portal_connections.verification_json.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/portal-connections";
import { verifyPortalAgainstCatalog } from "@/lib/portal-verification";
import { logAudit } from "@/lib/audit";

async function loadProjectAndCachedResult(projectId: string) {
  const supabase = createServiceClient();
  const { data: project } = await supabase
    .from("projects")
    .select("hub_id, theme_name")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return null;

  const { data: connection } = await supabase
    .from("portal_connections")
    .select("verification_json")
    .eq("hub_id", project.hub_id)
    .maybeSingle();

  return {
    project,
    cachedResult: connection?.verification_json ?? null,
    supabase,
  };
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const ctx = await loadProjectAndCachedResult(projectId);
  if (!ctx) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }
  return NextResponse.json({
    ok: true,
    result: ctx.cachedResult,
    themeName: ctx.project.theme_name,
  });
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;
  const ctx = await loadProjectAndCachedResult(projectId);
  if (!ctx) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(null, ctx.project.hub_id);
  } catch {
    return NextResponse.json({ ok: false, error: "Portal not connected" }, { status: 404 });
  }

  let result;
  try {
    result = await verifyPortalAgainstCatalog(accessToken, ctx.project.theme_name);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Verification failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  await ctx.supabase
    .from("portal_connections")
    .update({ verification_json: result })
    .eq("hub_id", ctx.project.hub_id);

  await logAudit({
    userId: null,
    hubId: ctx.project.hub_id,
    action: "portal.refreshed",
    resourceType: "portal_connection",
    resourceId: String(ctx.project.hub_id),
    metadata: {
      step: "verification",
      allModulesPresent: result.allModulesPresent,
      missingCount: result.missingCount,
    },
  });

  return NextResponse.json({ ok: true, result });
}