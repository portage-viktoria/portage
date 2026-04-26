/**
 * Source page parsing route.
 *
 * POST /api/sources/parse
 * Body: { url: string, hubId?: number }
 *
 * Renders the URL with Browserless, captures a screenshot, runs the section
 * detector on the rendered HTML, uploads the screenshot to Supabase Storage,
 * and stores the parsed result in source_pages for caching.
 *
 * GET /api/sources/parse?url=...&hubId=...
 *   Returns the cached parsed result if one exists.
 */

import { NextRequest, NextResponse } from "next/server";
import { renderHtml, screenshotPage } from "@/lib/browserless";
import { parseSourcePage } from "@/lib/source-parser";
import { uploadScreenshot } from "@/lib/screenshot-storage";
import { createServiceClient } from "@/lib/supabase";
import { logAudit } from "@/lib/audit";

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

function parseHubId(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isInteger(raw)) return raw;
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (!isNaN(n)) return n;
  }
  return null;
}

export async function POST(request: NextRequest) {
  let payload: { url?: string; hubId?: number | string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid request body" },
      { status: 400 }
    );
  }

  const url = normalizeUrl(payload.url);
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "Provide a valid http(s) URL" },
      { status: 400 }
    );
  }

  const hubId = parseHubId(payload.hubId);

  // Step 1: render + screenshot in parallel (separate Browserless calls,
  // both moderately slow — running together saves a few seconds)
  let renderedHtml: string;
  let screenshotBytes: Uint8Array;
  try {
    [renderedHtml, screenshotBytes] = await Promise.all([
      renderHtml(url),
      screenshotPage(url),
    ]);
  } catch (err) {
    console.error("[parse] browserless failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error:
          (err as Error).message ??
          "Couldn't render the page. The URL may be unreachable or blocked.",
      },
      { status: 502 }
    );
  }

  // Step 2: parse the HTML into sections
  const parsed = parseSourcePage(url, renderedHtml);

  // Step 3: upload the full-page screenshot
  const screenshotUrl = await uploadScreenshot(
    hubId,
    url,
    "full.png",
    screenshotBytes
  );

  // Step 4: cache the result
  const supabase = createServiceClient();

  // Manual delete-then-insert because user_id is null and the unique constraint
  // (hub_id, source_url) interacts oddly with null hub_id.
  if (hubId === null) {
    await supabase.from("source_pages").delete().is("hub_id", null).eq("source_url", url);
  } else {
    await supabase
      .from("source_pages")
      .delete()
      .eq("hub_id", hubId)
      .eq("source_url", url);
  }

  const { error: dbError } = await supabase.from("source_pages").insert({
    hub_id: hubId,
    source_url: url,
    parsed_json: parsed,
    section_count: parsed.sectionCount,
    full_screenshot_path: screenshotUrl,
    parsed_at: parsed.parsedAt,
  });

  if (dbError) {
    console.error("[parse] failed to cache:", dbError);
    // Don't fail the request — return the result anyway
  }

  await logAudit({
    userId: null,
    hubId,
    action: "migration.started",
    resourceType: "source_page",
    resourceId: url,
    metadata: {
      section_count: parsed.sectionCount,
      warnings: parsed.warnings.length,
    },
  });

  return NextResponse.json({
    ok: true,
    ...parsed,
    fullScreenshotUrl: screenshotUrl,
  });
}

export async function GET(request: NextRequest) {
  const url = normalizeUrl(request.nextUrl.searchParams.get("url"));
  if (!url) {
    return NextResponse.json(
      { ok: false, error: "Provide a valid url query param" },
      { status: 400 }
    );
  }

  const hubId = parseHubId(request.nextUrl.searchParams.get("hubId"));

  const supabase = createServiceClient();
  let query = supabase
    .from("source_pages")
    .select("parsed_json, full_screenshot_path, parsed_at")
    .eq("source_url", url);

  if (hubId === null) {
    query = query.is("hub_id", null);
  } else {
    query = query.eq("hub_id", hubId);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: "Database error" }, { status: 500 });
  }

  if (!data) {
    return NextResponse.json({ ok: false, cached: false }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    cached: true,
    ...data.parsed_json,
    fullScreenshotUrl: data.full_screenshot_path,
  });
}