/**
 * Module matcher.
 *
 * Given a list of classified sections and a theme's indexed module catalog,
 * uses Claude to select the best-fitting module for each section and
 * produce a content-to-field mapping.
 *
 * Architecture: one Claude call per section. Slightly more expensive than
 * batching, but each match is independent which makes the UX simpler
 * (per-section retry, per-section swap in a future milestone).
 *
 * The matcher operates in two passes per section:
 *   1. Filter the catalog to candidate modules whose structural tags overlap
 *      with the section's classified type.
 *   2. Send the section's content + the candidate modules' shapes to Claude,
 *      which picks one and maps content to fields.
 */

import { callAnthropic, extractText, parseJsonResponse } from "./anthropic";

// ============================================================
// Input types
// ============================================================

export type MatcherInputSection = {
  id: string;
  classifiedType: string;
  classifiedConfidence: number;
  heading?: string;
  text: string;
  headings: Array<{ level: number; text: string }>;
  images: Array<{ src: string; alt?: string }>;
  links: Array<{ text: string; href: string }>;
  wordCount: number;
};

// Module entries as stored in theme_indexes.modules_json
export type CatalogModule = {
  name: string;
  label: string;
  description?: string;
  path: string;
  fields: Array<{ type: string; category: string; count: number }>;
  hasRepeater: boolean;
  totalFields: number;
  tags: string[];
  metaTags?: string[];
};

// ============================================================
// Output types
// ============================================================

export type FieldMapping = {
  fieldName: string;          // module's field name from fields.json
  fieldType: string;          // category like "text", "image", "link"
  source: "heading" | "text" | "image" | "link" | "literal" | "list";
  // For source="literal", the actual value
  // For others, an index/path describing where the data comes from
  value?: string;
  description: string;        // human-readable: "Section heading", "First image", etc.
};

export type MatcherResult = {
  sectionId: string;
  matchedModule: string;       // module.name from catalog, or "rich_text_fallback"
  matchedModulePath: string;
  confidence: number;
  reasoning: string;
  fieldMappings: FieldMapping[];
  // If true, no good match was found and we'll fall back to a generic rich_text module
  isFallback: boolean;
};

// ============================================================
// Candidate filtering — narrow the catalog before asking Claude
// ============================================================

const TYPE_TO_TAGS: Record<string, string[]> = {
  hero: ["hero"],
  "logo-strip": ["logo-strip"],
  "feature-grid": ["card-grid", "feature-list", "feature-grid"],
  "feature-list": ["feature-list", "card-grid"],
  "card-grid": ["card-grid", "feature-list", "gallery"],
  accordion: ["accordion"],
  tabs: ["tabs"],
  testimonial: ["testimonial"],
  stats: ["stats"],
  "cta-banner": ["cta-banner"],
  gallery: ["gallery", "card-grid"],
  "blog-listing": ["blog-listing", "card-grid"],
  "rich-text": ["rich-text"],
  form: ["form"],
  menu: ["menu"],
  other: [],
};

function filterCandidates(
  classifiedType: string,
  catalog: CatalogModule[]
): CatalogModule[] {
  const desiredTags = new Set(TYPE_TO_TAGS[classifiedType] ?? []);
  if (desiredTags.size === 0) return catalog;

  const matches = catalog.filter((m) => {
    if (!Array.isArray(m.tags)) return false;
    return m.tags.some((t) => desiredTags.has(t));
  });

  // If filtering produced nothing useful, fall back to the full catalog so
  // Claude can pick anything. Better than telling it "you have no options."
  return matches.length > 0 ? matches : catalog;
}

// ============================================================
// Prompt construction
// ============================================================

const SYSTEM_PROMPT = `You are matching a section of a webpage to a HubSpot CMS module that will hold its content.

You receive:
1. A SECTION with extracted content (heading, text, images, links)
2. A list of CANDIDATE MODULES with their fields

Your job is to:
1. Pick the SINGLE best-fitting module from the candidates
2. Map the section's content into that module's fields
3. Provide a confidence score (0.0-1.0) and brief reasoning

Field mapping rules:
- For text fields, map the section's heading to a heading-like field, body text to a text/richtext field
- For image fields, use the section's images in document order (first image to first image field, etc.)
- For link fields, map link text + href; prefer the most prominent link as the primary CTA
- For repeater fields (groups with multiple items), only mark them as needing manual splitting — set source="list" and leave value empty
- If the section has more content than the module can hold, ignore the extras
- If the module has fields that the section doesn't fill, leave those mappings out

Respond with a JSON object only — no markdown, no extra text:
{
  "matchedModule": "module-name",
  "confidence": 0.0-1.0,
  "reasoning": "one short sentence",
  "fieldMappings": [
    {
      "fieldName": "headline",
      "fieldType": "text",
      "source": "heading",
      "description": "Section's primary heading"
    },
    {
      "fieldName": "body",
      "fieldType": "text",
      "source": "text",
      "description": "Full section text"
    },
    {
      "fieldName": "image",
      "fieldType": "image",
      "source": "image",
      "value": "0",
      "description": "First image in section"
    }
  ]
}

If no module is a reasonable fit, set "matchedModule" to "rich_text_fallback" and provide a single mapping for the whole content.`;

function buildUserPrompt(
  section: MatcherInputSection,
  candidates: CatalogModule[]
): string {
  const parts: string[] = [];

  parts.push("=== SECTION TO MATCH ===");
  parts.push(`ID: ${section.id}`);
  parts.push(`Classified type: ${section.classifiedType} (confidence ${section.classifiedConfidence.toFixed(2)})`);
  if (section.heading) parts.push(`Primary heading: ${section.heading}`);
  if (section.headings.length > 0) {
    parts.push(`All headings: ${section.headings.slice(0, 8).map((h) => `H${h.level}: ${h.text}`).join(" | ")}`);
  }
  parts.push(`Word count: ${section.wordCount}`);
  parts.push(`Image count: ${section.images.length}`);
  if (section.images.length > 0) {
    parts.push(`Image alts: ${section.images.slice(0, 5).map((i) => i.alt ?? "(no alt)").join(" | ")}`);
  }
  if (section.links.length > 0) {
    parts.push(`Links: ${section.links.slice(0, 5).map((l) => l.text).join(" | ")}`);
  }
  const truncatedText = section.text.length > 600 ? section.text.slice(0, 600) + "…" : section.text;
  parts.push(`Text:\n${truncatedText}`);

  parts.push("");
  parts.push("=== CANDIDATE MODULES ===");

  for (const m of candidates.slice(0, 12)) {
    parts.push(`--- ${m.name} ---`);
    parts.push(`Label: ${m.label}`);
    if (m.description) parts.push(`Description: ${m.description}`);
    parts.push(`Tags: ${m.tags.join(", ")}`);
    parts.push(`Has repeater: ${m.hasRepeater}`);
    parts.push(`Field summary: ${m.fields.map((f) => `${f.category}×${f.count}`).join(", ")}`);
    parts.push("");
  }

  return parts.join("\n");
}

// ============================================================
// Per-section matching
// ============================================================

async function matchSingleSection(
  section: MatcherInputSection,
  catalog: CatalogModule[]
): Promise<MatcherResult> {
  const candidates = filterCandidates(section.classifiedType, catalog);

  if (candidates.length === 0) {
    return {
      sectionId: section.id,
      matchedModule: "rich_text_fallback",
      matchedModulePath: "",
      confidence: 0,
      reasoning: "No candidate modules in theme catalog.",
      fieldMappings: [],
      isFallback: true,
    };
  }

  const prompt = buildUserPrompt(section, candidates);

  let response;
  try {
    response = await callAnthropic({
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      maxTokens: 1024,
    });
  } catch (err) {
    return {
      sectionId: section.id,
      matchedModule: "rich_text_fallback",
      matchedModulePath: "",
      confidence: 0,
      reasoning: `Matcher API failed: ${(err as Error).message}`,
      fieldMappings: [],
      isFallback: true,
    };
  }

  const text = extractText(response);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonResponse<Record<string, unknown>>(text);
  } catch {
    return {
      sectionId: section.id,
      matchedModule: "rich_text_fallback",
      matchedModulePath: "",
      confidence: 0,
      reasoning: "Matcher returned non-JSON response.",
      fieldMappings: [],
      isFallback: true,
    };
  }

  const matchedModule =
    typeof parsed.matchedModule === "string" ? parsed.matchedModule : "rich_text_fallback";
  const isFallback = matchedModule === "rich_text_fallback";

  // Find the module in the catalog so we know its full path
  const found = candidates.find((c) => c.name === matchedModule);
  const matchedModulePath = found?.path ?? "";

  const confidence =
    typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning.trim() : "";

  const rawMappings = Array.isArray(parsed.fieldMappings) ? parsed.fieldMappings : [];
  const fieldMappings: FieldMapping[] = [];

  for (const m of rawMappings) {
    if (!m || typeof m !== "object") continue;
    const mm = m as Record<string, unknown>;
    const fieldName = typeof mm.fieldName === "string" ? mm.fieldName : null;
    const fieldType = typeof mm.fieldType === "string" ? mm.fieldType : null;
    const source = typeof mm.source === "string" ? mm.source : null;
    const description = typeof mm.description === "string" ? mm.description : "";
    if (!fieldName || !fieldType || !source) continue;
    fieldMappings.push({
      fieldName,
      fieldType,
      source: source as FieldMapping["source"],
      value: typeof mm.value === "string" ? mm.value : undefined,
      description,
    });
  }

  return {
    sectionId: section.id,
    matchedModule,
    matchedModulePath,
    confidence,
    reasoning,
    fieldMappings,
    isFallback,
  };
}

// ============================================================
// Top-level
// ============================================================

const CONCURRENCY = 4;

export async function matchSections(
  sections: MatcherInputSection[],
  catalog: CatalogModule[]
): Promise<MatcherResult[]> {
  if (sections.length === 0) return [];

  const results: MatcherResult[] = new Array(sections.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= sections.length) return;
      results[i] = await matchSingleSection(sections[i], catalog);
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, sections.length) },
    worker
  );
  await Promise.all(workers);

  return results;
}