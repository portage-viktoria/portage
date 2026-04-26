/**
 * Classify the sections of a parsed page using Claude.
 *
 * POST /api/projects/[projectId]/pages/[pageId]/classify
 *
 * Loads the page's parsed_json, builds compact inputs, calls the classifier,
 * and stores the result in classifications_json with status=classified.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import {
  classifySections,
  ClassifierInputSection,
} from "@/lib/section-classifier";
import { logAudit } from "@/lib/audit";

type ParsedJson = {
  sections: Array<{
    id: string;
    content: {
      heading?: string;
      text: string;
      headings: Array<{ level: number; text: string }>;
      images: Array<{ alt?: string }>;
      links: Array<{ text: string }>;
      wordCount: number;
    };
  }>;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; pageId: string }> }
) {
  const { projectId, pageId } = await params;
  const supabase = createServiceClient();

  // Load the page
  const { data: page, error: loadError } = await supabase
    .from("migration_pages")
    .select("id, parsed_json, status, project_id")
    .eq("project_id", projectId)
    .eq("id", pageId)
    .maybeSingle();

  if (loadError || !page) {
    return NextResponse.json({ ok: false, error: "Page not found" }, { status: 404 });
  }

  if (!page.parsed_json) {
    return NextResponse.json(
      { ok: false, error: "Page hasn't been parsed yet" },
      { status: 400 }
    );
  }

  // Mark as classifying so the UI can show a loading state if it polls
  await supabase
    .from("migration_pages")
    .update({ status: "classifying", status_message: null })
    .eq("id", pageId);

  // Build classifier inputs from parsed_json
  const parsedJson = page.parsed_json as ParsedJson;
  const sections = Array.isArray(parsedJson.sections) ? parsedJson.sections : [];

  if (sections.length === 0) {
    await supabase
      .from("migration_pages")
      .update({
        status: "error",
        status_message: "No sections to classify.",
      })
      .eq("id", pageId);
    return NextResponse.json(
      { ok: false, error: "No sections to classify" },
      { status: 400 }
    );
  }

  const inputs: ClassifierInputSection[] = sections.map((s) => ({
    id: s.id,
    heading: s.content?.heading,
    text: s.content?.text ?? "",
    headings: Array.isArray(s.content?.headings) ? s.content.headings : [],
    imageCount: Array.isArray(s.content?.images) ? s.content.images.length : 0,
    imageAlts: Array.isArray(s.content?.images)
      ? s.content.images.map((i) => i.alt ?? "").filter((a) => a.length > 0)
      : [],
    linkTexts: Array.isArray(s.content?.links)
      ? s.content.links.map((l) => l.text).filter((t) => t.length > 0)
      : [],
    wordCount: s.content?.wordCount ?? 0,
  }));

  let results;
  try {
    results = await classifySections(inputs);
  } catch (err) {
    console.error("[classify] failed:", err);
    const msg = (err as Error).message ?? "Classifier failed";
    await supabase
      .from("migration_pages")
      .update({ status: "error", status_message: msg })
      .eq("id", pageId);
    return NextResponse.json(
      { ok: false, error: msg },
      { status: 500 }
    );
  }

  // Save results
  const { data: updated, error: updateError } = await supabase
    .from("migration_pages")
    .update({
      classifications_json: { sections: results, classifiedAt: new Date().toISOString() },
      status: "classified",
      status_message: null,
    })
    .eq("id", pageId)
    .select()
    .single();

  if (updateError) {
    console.error("[classify] save failed:", updateError);
    return NextResponse.json(
      { ok: false, error: "Failed to save classifications" },
      { status: 500 }
    );
  }

  await logAudit({
    userId: null,
    hubId: null,
    action: "migration.completed",
    resourceType: "page",
    resourceId: pageId,
    metadata: {
      step: "classify",
      classification_count: results.length,
    },
  });

  return NextResponse.json({ ok: true, page: updated, classifications: results });
}