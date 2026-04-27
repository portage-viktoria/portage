/**
 * Match endpoint.
 *
 * POST /api/projects/[projectId]/pages/[pageId]/match
 *
 * Loads the page's classifications + the project's theme catalog, runs the
 * module matcher per section, stores results in matches_json, status->matched.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
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

  // Load theme catalog
  const { data: themeIndex, error: indexError } = await supabase
    .from("theme_indexes")
    .select("modules_json")
    .eq("hub_id", project.hub_id)
    .eq("theme_path", project.theme_path)
    .maybeSingle();
  if (indexError || !themeIndex) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Theme hasn't been indexed yet. Index the theme on the main page first.",
      },
      { status: 400 }
    );
  }

  const catalog: CatalogModule[] =
    Array.isArray((themeIndex.modules_json as ThemeIndexJson).modules)
      ? (themeIndex.modules_json as ThemeIndexJson).modules
      : [];

  if (catalog.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Theme catalog is empty. Re-index the theme." },
      { status: 400 }
    );
  }

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