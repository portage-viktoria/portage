/**
 * Match endpoint — Patch B.
 *
 * Loads the reference catalog, the project's theme name, and runs the
 * reference-based matcher. Stores the result in matches_json.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { loadCatalog } from "@/lib/reference-catalog";
import { matchPageWithCatalog, type ParsedSection } from "@/lib/reference-matcher";
import { logAudit } from "@/lib/audit";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId, pageId } = await params;
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
    .select("hub_id, theme_name")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  let catalog;
  try {
    catalog = await loadCatalog();
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Failed to load reference catalog: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  const sections: ParsedSection[] =
    (page.parsed_json as { sections?: ParsedSection[] })?.sections ?? [];

  if (sections.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Page has no parsed sections — re-parse the page first" },
      { status: 400 }
    );
  }

  await supabase
    .from("migration_pages")
    .update({ status: "matching", status_message: null })
    .eq("id", pageId);

  let result;
  try {
    result = await matchPageWithCatalog(sections, catalog, project.theme_name);
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
    matchedAt: new Date().toISOString(),
    catalogVersion: catalog.loadedAt,
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
      sectionCount: result.matches.length,
      fallbackCount: result.matches.filter((m) => m.isFallback).length,
    },
  });

  return NextResponse.json({
    ok: true,
    page: updated,
    matches: result.matches,
  });
}