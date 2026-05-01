/**
 * Match endpoint — v2 with rulebook integration.
 *
 * Flow:
 *   1. Load page + project + theme catalog (with HubL render summaries)
 *   2. Try to load a rulebook for the theme
 *   3. If rulebook exists: run new rulebook-aware matcher
 *      Otherwise: return early with hint that no rulebook is set up
 *
 * The "no rulebook" response gives the client a structured signal so it
 * can show the "Set up rulebook" prompt instead of bad matches.
 *
 * Force the old matcher with ?force=legacy to bypass the rulebook check.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { matchPageWithRulebook, type CatalogEntry } from "@/lib/rulebook-matcher";
import { loadRulebook } from "@/lib/rulebook";
import { logAudit } from "@/lib/audit";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId, pageId } = await params;
  const url = new URL(request.url);
  const force = url.searchParams.get("force"); // "legacy" or "rulebook" or null

  const supabase = createServiceClient();

  const { data: page, error: pageError } = await supabase
    .from("migration_pages")
    .select("id, project_id, parsed_json, status")
    .eq("project_id", projectId)
    .eq("id", pageId)
    .maybeSingle();
  if (pageError || !page) {
    return NextResponse.json({ ok: false, error: "Page not found" }, { status: 404 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("hub_id, theme_path")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  // Load catalog
  const { data: themeIndex } = await supabase
    .from("theme_indexes")
    .select("modules_json")
    .eq("hub_id", project.hub_id)
    .eq("theme_path", project.theme_path)
    .maybeSingle();

  if (!themeIndex) {
    return NextResponse.json(
      {
        ok: false,
        error: "Theme not indexed yet — re-index the theme before matching",
      },
      { status: 400 }
    );
  }

  type IndexedModule = {
    name?: unknown;
    label?: unknown;
    path?: unknown;
    apiPath?: unknown;
    fieldDetails?: unknown;
    renderSummaryText?: unknown;
  };

  const rawModules: IndexedModule[] =
    Array.isArray((themeIndex.modules_json as { modules?: unknown })?.modules)
      ? ((themeIndex.modules_json as { modules: IndexedModule[] }).modules)
      : [];

  const catalog: CatalogEntry[] = rawModules
    .filter((m): m is IndexedModule & { name: string; path: string } =>
      typeof m.name === "string" && typeof m.path === "string"
    )
    .map((m) => ({
      name: m.name,
      label: typeof m.label === "string" ? m.label : undefined,
      path: m.path,
      apiPath: typeof m.apiPath === "string" ? m.apiPath : undefined,
      fieldDetails: Array.isArray(m.fieldDetails)
        ? (m.fieldDetails as CatalogEntry["fieldDetails"])
        : undefined,
      renderSummaryText: typeof m.renderSummaryText === "string" ? m.renderSummaryText : undefined,
    }));

  // Load rulebook (may be null)
  const rulebook = await loadRulebook(project.hub_id, project.theme_path);

  // Soft nudge: if no rulebook AND user didn't force legacy, return a hint
  if (!rulebook && force !== "legacy") {
    return NextResponse.json({
      ok: false,
      reason: "no_rulebook",
      message:
        "No rulebook exists for this theme. Setting one up takes about 10 minutes and significantly improves matching accuracy. You can also proceed without one — match quality will be lower.",
      hubId: project.hub_id,
      themePath: project.theme_path,
    }, { status: 409 });
  }

  // If user forced legacy OR rulebook exists, run the rulebook matcher
  // (When rulebook is null but force=legacy, the matcher falls back to rich text for everything)

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "Server configuration error: missing API key" },
      { status: 500 }
    );
  }

  const sections = (page.parsed_json as { sections?: unknown[] })?.sections ?? [];

  await supabase
    .from("migration_pages")
    .update({ status: "matching", status_message: null })
    .eq("id", pageId);

  let result;
  try {
    result = await matchPageWithRulebook({
      apiKey,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sections: sections as any,
      catalog,
      rulebook,
    });
  } catch (err) {
    const msg = `Matching failed: ${(err as Error).message}`;
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: msg })
      .eq("id", pageId);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }

  const matchesPayload = {
    sections: result.matches,
    patterns: result.patterns,
    rulebookUsed: result.rulebookUsed,
    matchedAt: new Date().toISOString(),
  };

  const { data: updated } = await supabase
    .from("migration_pages")
    .update({
      matches_json: matchesPayload,
      status: "matched",
      status_message: null,
    })
    .eq("id", pageId)
    .select()
    .single();

  await logAudit({
    userId: null,
    hubId: project.hub_id,
    action: "page.updated",
    resourceType: "page",
    resourceId: pageId,
    metadata: {
      step: "match",
      rulebookUsed: result.rulebookUsed,
      sectionCount: result.matches.length,
      fallbackCount: result.matches.filter((m) => m.isFallback).length,
    },
  });

  return NextResponse.json({
    ok: true,
    page: updated,
    matches: result.matches,
    patterns: result.patterns,
    rulebookUsed: result.rulebookUsed,
  });
}