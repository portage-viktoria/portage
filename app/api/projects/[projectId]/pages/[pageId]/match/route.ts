/**
 * Match endpoint.
 *
 * POST /api/projects/[projectId]/pages/[pageId]/match
 *
 * Loads the page's classifications + the project's theme catalog, runs the
 * module matcher per section, stores results in matches_json, status->matched.
 *
 * If the theme isn't indexed yet (e.g., the project was created before the
 * auto-indexing fix), this route will index it inline as a fallback — so
 * existing projects "just work" without the user needing to detour anywhere.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/portal-connections";
import { indexTheme } from "@/lib/module-indexer";
import {
  matchSections,
  MatcherInputSection,
  CatalogModule,
} from "@/lib/module-matcher";
import { logAudit } from "@/lib/audit";

type ParsedJson = {
  sections: Array<{
    id: string;
    content: {
      heading?: string;
      text: string;
      headings: Array<{ level: number; text: string }>;
      images: Array<{ src: string; alt?: string }>;
      links: Array<{ text: string; href: string }>;
      wordCount: number;
    };
  }>;
};

type ClassificationsJson = {
  sections: Array<{
    id: string;
    type: string;
    confidence: number;
    reasoning?: string;
  }>;
};

type ThemeIndexJson = {
  modules: CatalogModule[];
};

/**
 * Get or create the theme catalog. If already cached, returns it. If not,
 * indexes the theme inline and caches it.
 */
async function getOrIndexThemeCatalog(
  hubId: number,
  themePath: string
): Promise<{ ok: true; catalog: CatalogModule[] } | { ok: false; error: string }> {
  const supabase = createServiceClient();

  // Try cache first
  const { data: existing } = await supabase
    .from("theme_indexes")
    .select("modules_json")
    .eq("hub_id", hubId)
    .eq("theme_path", themePath)
    .maybeSingle();

  if (existing) {
    const catalog = (existing.modules_json as ThemeIndexJson).modules ?? [];
    if (catalog.length > 0) {
      return { ok: true, catalog };
    }
    // Cached but empty — fall through and re-index
  }

  // Not cached or empty cache — index now
  let accessToken: string;
  try {
    accessToken = await getAccessToken(null, hubId);
  } catch {
    return {
      ok: false,
      error: "Portal not connected — can't index theme.",
    };
  }

  let result;
  try {
    result = await indexTheme(accessToken, themePath);
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't index theme: ${(err as Error).message}`,
    };
  }

  if (result.moduleCount === 0) {
    return {
      ok: false,
      error:
        "Theme has no readable modules. If this is a child theme of a marketplace " +
        "theme, you may need to clone the parent's modules into the child first.",
    };
  }

  // Cache the result for future calls
  await supabase.from("theme_indexes").upsert(
    {
      hub_id: hubId,
      theme_path: themePath,
      modules_json: result,
      module_count: result.moduleCount,
      indexed_at: result.scannedAt,
    },
    { onConflict: "hub_id,theme_path" }
  );

  return { ok: true, catalog: result.modules };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId, pageId } = await params;
  const supabase = createServiceClient();

  // Load page with classifications
  const { data: page, error: pageError } = await supabase
    .from("migration_pages")
    .select("id, project_id, parsed_json, classifications_json, status")
    .eq("project_id", projectId)
    .eq("id", pageId)
    .maybeSingle();

  if (pageError || !page) {
    return NextResponse.json({ ok: false, error: "Page not found" }, { status: 404 });
  }
  if (!page.parsed_json) {
    return NextResponse.json({ ok: false, error: "Page hasn't been parsed yet" }, { status: 400 });
  }
  if (!page.classifications_json) {
    return NextResponse.json(
      { ok: false, error: "Page hasn't been classified yet" },
      { status: 400 }
    );
  }

  // Load project to get theme path + portal
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("hub_id, theme_path")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  // Get or build theme catalog (auto-index if missing)
  const catalogResult = await getOrIndexThemeCatalog(project.hub_id, project.theme_path);
  if (!catalogResult.ok) {
    return NextResponse.json(
      { ok: false, error: catalogResult.error },
      { status: 400 }
    );
  }
  const catalog = catalogResult.catalog;

  // Build matcher inputs by joining parsed sections with classifications
  const parsedJson = page.parsed_json as ParsedJson;
  const classifications = (page.classifications_json as ClassificationsJson).sections ?? [];
  const classificationById = new Map(classifications.map((c) => [c.id, c]));

  const inputs: MatcherInputSection[] = parsedJson.sections.map((s) => {
    const cls = classificationById.get(s.id);
    return {
      id: s.id,
      classifiedType: cls?.type ?? "other",
      classifiedConfidence: cls?.confidence ?? 0,
      heading: s.content?.heading,
      text: s.content?.text ?? "",
      headings: Array.isArray(s.content?.headings) ? s.content.headings : [],
      images: Array.isArray(s.content?.images) ? s.content.images : [],
      links: Array.isArray(s.content?.links) ? s.content.links : [],
      wordCount: s.content?.wordCount ?? 0,
    };
  });

  // Mark as matching
  await supabase
    .from("migration_pages")
    .update({ status: "matching", status_message: null })
    .eq("id", pageId);

  let results;
  try {
    results = await matchSections(inputs, catalog);
  } catch (err) {
    console.error("[match] failed:", err);
    const msg = (err as Error).message ?? "Matcher failed";
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: msg })
      .eq("id", pageId);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const { data: updated, error: updateError } = await supabase
    .from("migration_pages")
    .update({
      matches_json: { sections: results, matchedAt: new Date().toISOString() },
      status: "matched",
      status_message: null,
    })
    .eq("id", pageId)
    .select()
    .single();

  if (updateError) {
    return NextResponse.json(
      { ok: false, error: "Failed to save matches" },
      { status: 500 }
    );
  }

  await logAudit({
    userId: null,
    hubId: project.hub_id,
    action: "migration.completed",
    resourceType: "page",
    resourceId: pageId,
    metadata: { step: "match", match_count: results.length },
  });

  return NextResponse.json({ ok: true, page: updated, matches: results });
}