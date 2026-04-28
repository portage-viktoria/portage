/**
 * Publish endpoint — updated for Phase 4.
 *
 * Loads the theme catalog and passes it through to createHubSpotPage so
 * each module's defaults can be merged with the matcher's params.
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
  CatalogModule,
} from "@/lib/hubspot-publish";
import { logAudit } from "@/lib/audit";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

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

async function validateTemplateExists(
  accessToken: string,
  themePath: string,
  templateName: string
): Promise<string | null> {
  const cleanTheme = themePath.replace(/^\/+/, "").replace(/\/+$/, "");
  const cleanTemplate = templateName.replace(/^\/+/, "").replace(/\/+$/, "");
  const fullPath = `${cleanTheme}/templates/${cleanTemplate}`;
  const encodedPath = fullPath.split("/").map(encodeURIComponent).join("/");
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/metadata/${encodedPath}`;

  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    });
    if (res.ok) return null;
    if (res.status === 404) {
      return (
        `Your theme is missing ${fullPath}. ` +
        `Create a drag-and-drop template at this path before publishing — ` +
        `see the Portage setup docs for the exact template contents.`
      );
    }
    return `Couldn't verify template (${res.status}). Try again in a moment.`;
  } catch (err) {
    return `Network error checking template: ${(err as Error).message}`;
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
    return NextResponse.json({ ok: false, error: "Page hasn't been matched yet" }, { status: 400 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("hub_id, theme_path, template_name")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  const templateName = project.template_name || "migration.html";

  let accessToken: string;
  try {
    accessToken = await getAccessToken(null, project.hub_id);
  } catch {
    return NextResponse.json({ ok: false, error: "Portal not connected" }, { status: 404 });
  }

  // Validate template exists before doing any expensive work
  const templateError = await validateTemplateExists(accessToken, project.theme_path, templateName);
  if (templateError) {
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: templateError })
      .eq("id", pageId);
    return NextResponse.json({ ok: false, error: templateError }, { status: 400 });
  }

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

  // Load theme catalog so the publisher can merge module defaults
  const { data: themeIndex } = await supabase
    .from("theme_indexes")
    .select("modules_json")
    .eq("hub_id", project.hub_id)
    .eq("theme_path", project.theme_path)
    .maybeSingle();

  type IndexedModule = {
    name?: unknown;
    path?: unknown;
    apiPath?: unknown;
    defaults?: unknown;
  };

  const rawModules: IndexedModule[] =
    Array.isArray((themeIndex?.modules_json as { modules?: unknown })?.modules)
      ? ((themeIndex?.modules_json as { modules: IndexedModule[] }).modules)
      : [];

  const catalog: CatalogModule[] = rawModules
    .filter((m): m is IndexedModule & { name: string; path: string } =>
      typeof m.name === "string" && typeof m.path === "string"
    )
    .map((m) => ({
      name: m.name,
      path: m.path,
      apiPath: typeof m.apiPath === "string" ? m.apiPath : undefined,
      defaults:
        m.defaults && typeof m.defaults === "object"
          ? (m.defaults as Record<string, unknown>)
          : undefined,
    }));

  await supabase
    .from("migration_pages")
    .update({ status: "publishing", status_message: null })
    .eq("id", pageId);

  const sections: ParsedSection[] =
    (page.parsed_json as { sections?: ParsedSection[] })?.sections ?? [];
  const matches: SectionMatch[] =
    (page.matches_json as { sections?: SectionMatch[] })?.sections ?? [];

  const sourceDomain = deriveDomainFromUrl(page.source_url);
  const pageTitle = body.pageTitle?.trim() || page.page_title || "Untitled migrated page";
  const pageSlug = body.pageSlug?.trim() || deriveSlugFromUrl(page.source_url);
  const metaDescription = body.metaDescription?.trim() || page.page_description || "";

  let imageUrlMap: Map<string, string>;
  try {
    imageUrlMap = await uploadImagesToFileManager(accessToken, sections, sourceDomain);
  } catch (err) {
    const msg = `Image upload failed: ${(err as Error).message}`;
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: msg })
      .eq("id", pageId);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const result = await createHubSpotPage({
    accessToken,
    pageTitle,
    pageSlug,
    metaDescription,
    themePath: project.theme_path,
    templateName,
    sections,
    matches,
    imageUrlMap,
    contentStagingState: destination,
    catalog,
  });

  if (!result.ok) {
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: result.error })
      .eq("id", pageId);
    return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
  }

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