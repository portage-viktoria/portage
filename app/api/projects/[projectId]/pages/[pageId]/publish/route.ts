/**
 * Publish endpoint.
 *
 * POST /api/projects/[projectId]/pages/[pageId]/publish
 * Body: {
 *   destination: "STAGING" | "DRAFT",
 *   pageTitle?: string,    // override; defaults to parsed page_title
 *   pageSlug?: string,     // override; defaults to derived from source URL
 *   metaDescription?: string,
 * }
 *
 * Flow:
 *   1. Load page (must be in 'matched' state)
 *   2. If destination=STAGING, verify tier supports it
 *   3. Upload images to File Manager
 *   4. Create the HubSpot page
 *   5. Store hubspot_page_id + url, status->published
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/portal-connections";
import {
  uploadImagesToFileManager,
  createHubSpotPage,
  detectStagingAvailable,
  ParsedSection,
  SectionMatch,
} from "@/lib/hubspot-publish";
import { logAudit } from "@/lib/audit";

function deriveSlugFromUrl(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl);
    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    if (path.length === 0) return "home";
    return path.replace(/\//g, "-").toLowerCase();
  } catch {
    return "page";
  }
}

function deriveDomainFromUrl(sourceUrl: string): string {
  try {
    return new URL(sourceUrl).hostname.replace(/[^a-z0-9.-]/gi, "");
  } catch {
    return "unknown";
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId, pageId } = await params;

  let body: {
    destination?: string;
    pageTitle?: string;
    pageSlug?: string;
    metaDescription?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const destination = body.destination === "STAGING" ? "STAGING" : "DRAFT";

  const supabase = createServiceClient();

  const { data: page, error: pageError } = await supabase
    .from("migration_pages")
    .select(
      "id, project_id, source_url, page_title, page_description, parsed_json, matches_json, status"
    )
    .eq("project_id", projectId)
    .eq("id", pageId)
    .maybeSingle();
  if (pageError || !page) {
    return NextResponse.json({ ok: false, error: "Page not found" }, { status: 404 });
  }

  if (!page.matches_json) {
    return NextResponse.json(
      { ok: false, error: "Page hasn't been matched yet" },
      { status: 400 }
    );
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("hub_id, theme_path")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
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

  // Tier check if user picked staging
  if (destination === "STAGING") {
    const stagingOk = await detectStagingAvailable(accessToken);
    if (!stagingOk) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Content staging isn't available on this portal's plan. Please choose 'Live as draft' instead.",
        },
        { status: 400 }
      );
    }
  }

  // Mark as publishing
  await supabase
    .from("migration_pages")
    .update({ status: "publishing", status_message: null })
    .eq("id", pageId);

  const sections: ParsedSection[] =
    (page.parsed_json as { sections?: ParsedSection[] })?.sections ?? [];
  const matches: SectionMatch[] =
    (page.matches_json as { sections?: SectionMatch[] })?.sections ?? [];

  const sourceDomain = deriveDomainFromUrl(page.source_url);
  const pageTitle =
    body.pageTitle?.trim() || page.page_title || "Untitled migrated page";
  const pageSlug = body.pageSlug?.trim() || deriveSlugFromUrl(page.source_url);
  const metaDescription =
    body.metaDescription?.trim() || page.page_description || "";

  // Upload images
  let imageUrlMap: Map<string, string>;
  try {
    imageUrlMap = await uploadImagesToFileManager(
      accessToken,
      sections,
      sourceDomain
    );
  } catch (err) {
    const msg = `Image upload failed: ${(err as Error).message}`;
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: msg })
      .eq("id", pageId);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  // Create page
  const result = await createHubSpotPage({
    accessToken,
    pageTitle,
    pageSlug,
    metaDescription,
    themePath: project.theme_path,
    sections,
    matches,
    imageUrlMap,
    contentStagingState: destination,
  });

  if (!result.ok) {
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: result.error })
      .eq("id", pageId);
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }

  // Save success
  const { data: updated } = await supabase
    .from("migration_pages")
    .update({
      status: "published",
      status_message: null,
      hubspot_page_id: result.pageId,
      hubspot_page_url: result.url ?? null,
    })
    .eq("id", pageId)
    .select()
    .single();

  await logAudit({
    userId: null,
    hubId: project.hub_id,
    action: "migration.completed",
    resourceType: "page",
    resourceId: pageId,
    metadata: {
      step: "publish",
      destination,
      hubspot_page_id: result.pageId,
      images_uploaded: imageUrlMap.size,
    },
  });

  return NextResponse.json({
    ok: true,
    page: updated,
    hubspotPageId: result.pageId,
    hubspotUrl: result.url,
  });
}