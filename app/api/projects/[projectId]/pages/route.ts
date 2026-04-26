/**
 * Add a page to a project.
 *
 * POST /api/projects/[projectId]/pages
 * Body: { url: string }
 *
 * This is a higher-level operation than just creating a row — we also kick
 * off the parse, since adding a page without parsing it is rarely useful.
 *
 * Flow:
 *   1. Validate URL
 *   2. Create the migration_pages row with status=parsing
 *   3. Render + screenshot via Browserless
 *   4. Run the section parser
 *   5. Upload screenshot
 *   6. Update the row with parsed data, status=parsed, page metadata
 *
 * Returns the created page.
 */

import { NextRequest, NextResponse } from "next/server";
import { renderHtml, screenshotPage } from "@/lib/browserless";
import { parseSourcePage } from "@/lib/source-parser";
import { uploadScreenshot } from "@/lib/screenshot-storage";
import { createServiceClient } from "@/lib/supabase";

function normalizeUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  const url = normalizeUrl(body.url);
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "Provide a valid http(s) URL" },
      { status: 400 }
    );
  }

  const supabase = createServiceClient();

  // Verify project exists
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, hub_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ ok: false, error: "Project not found" }, { status: 404 });
  }

  // Insert (or update) the page row in 'parsing' state
  const { data: pageRow, error: insertError } = await supabase
    .from("migration_pages")
    .upsert(
      {
        project_id: projectId,
        source_url: url,
        status: "parsing",
        status_message: null,
      },
      { onConflict: "project_id,source_url" }
    )
    .select()
    .single();
  if (insertError || !pageRow) {
    console.error("[add-page] insert failed:", insertError);
    return NextResponse.json(
      { ok: false, error: "Failed to create page row" },
      { status: 500 }
    );
  }

  // Render + screenshot
  let renderedHtml: string;
  let screenshotBytes: Uint8Array;
  try {
    [renderedHtml, screenshotBytes] = await Promise.all([
      renderHtml(url),
      screenshotPage(url),
    ]);
  } catch (err) {
    const msg = (err as Error).message ?? "Browserless failed";
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: msg })
      .eq("id", pageRow.id);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 502 }
    );
  }

  const parsed = parseSourcePage(url, renderedHtml);
  const screenshotUrl = await uploadScreenshot(
    project.hub_id,
    url,
    "full.png",
    screenshotBytes
  );

  const { data: updated, error: updateError } = await supabase
    .from("migration_pages")
    .update({
      status: parsed.sectionCount > 0 ? "parsed" : "error",
      status_message:
        parsed.sectionCount > 0
          ? null
          : "No sections detected during parsing.",
      parsed_json: parsed,
      section_count: parsed.sectionCount,
      page_title: parsed.pageTitle ?? null,
      page_description: parsed.pageDescription ?? null,
      full_screenshot_url: screenshotUrl,
    })
    .eq("id", pageRow.id)
    .select()
    .single();

  if (updateError) {
    console.error("[add-page] update failed:", updateError);
    return NextResponse.json(
      { ok: false, error: "Failed to save parse result" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, page: updated });
}