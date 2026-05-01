/**
 * Rulebook-aware matcher.
 *
 * Pipeline per page:
 *   1. Classify sections into patterns (one Claude call, all sections)
 *   2. For each section:
 *      a. Look up pattern in the rulebook → canonical module
 *      b. If no rule (or pattern == rich-text-fallback) → rich text fallback (no Claude call)
 *      c. Else: run field mapping for that one section, with the module's
 *         HubL render summary in the prompt
 */

import { callAnthropic, extractText, parseJsonResponse } from "./anthropic";
import { classifySections, type ParsedSection, type SectionPatternResult } from "./section-classifier-v2";
import { resolvePatternToModule, type Rulebook } from "./rulebook";
import type { SectionPattern } from "./patterns";

const RICH_TEXT_MODULE_NAME = "@hubspot/rich_text";
const RICH_TEXT_API_PATH = "@hubspot/rich_text";

export type FieldMapping = {
  fieldName: string;
  fieldType: string;
  source: "heading" | "text" | "image" | "link" | "literal" | "list";
  value?: string;
  description: string;
};

export type SectionMatch = {
  sectionId: string;
  pattern: SectionPattern;
  matchedModule: string;
  matchedModulePath: string;
  confidence: number;
  reasoning: string;
  fieldMappings: FieldMapping[];
  isFallback: boolean;
};

export type CatalogEntry = {
  name: string;
  label?: string;
  path: string;
  apiPath?: string;
  fieldDetails?: Array<{
    name: string;
    label?: string;
    type: string;
    category?: string;
    isRepeater?: boolean;
    childFields?: Array<{ name: string; type: string; category?: string }>;
  }>;
  renderSummaryText?: string;
};

// ============================================================
// Field mapping for a single section against a known module
// ============================================================

function summarizeSectionForMapping(s: ParsedSection) {
  return {
    id: s.id,
    heading: s.content.heading ?? "",
    headings: s.content.headings.slice(0, 8).map((h) => `H${h.level}: ${h.text}`),
    text: (s.content.text ?? "").slice(0, 800),
    images: s.content.images.slice(0, 5).map((img, i) => ({ index: i, alt: img.alt ?? "" })),
    links: s.content.links.slice(0, 8).map((l, i) => ({ index: i, text: l.text })),
  };
}

async function mapFieldsWithRenderContext(
  section: ParsedSection,
  module: CatalogEntry
): Promise<{ mappings: FieldMapping[]; reasoning: string }> {
  const sectionSummary = summarizeSectionForMapping(section);
  const fieldDetails = module.fieldDetails ?? [];

  const allowedNames = fieldDetails
    .map((f) => `  - "${f.name}" (${f.type}${f.isRepeater ? ", REPEATER" : ""})`)
    .join("\n");

  const renderSection = module.renderSummaryText
    ? `\n\nHOW EACH FIELD RENDERS IN THE MODULE TEMPLATE:
${module.renderSummaryText}

CRITICAL: Use this rendering info to make smart placement decisions.
- A field that renders inside <h1>, <h2>, <h3> should ONLY receive heading text, never paragraph text.
- A field that renders inside <p class="eyebrow"> or similar small classes is a tagline/superhead, not the main heading.
- A field that renders inside a richtext-style div (<div class="rich-content">, <div class="content">, etc.) is for body paragraphs, NOT for heading text.
- DO NOT place the section's main heading text into both an h-tag field AND a body/richtext field. The heading goes in the heading field only.`
    : "";

  const prompt = `You're mapping content from a scraped web page section onto a HubSpot module's fields.

The module has been pre-selected based on the section's pattern, so you don't pick the module — you only decide which content goes into which field.

SECTION CONTENT:
${JSON.stringify(sectionSummary, null, 2)}

MODULE: ${module.name}
ALLOWED FIELD NAMES (use ONLY these names — never invent):
${allowedNames || "  (no fields)"}${renderSection}

For each allowed field, produce a mapping ONLY when the section has appropriate content for that field's role. Skip fields you have nothing for — defaults will fill them in.

For each mapping:
  - fieldName: EXACTLY one of the allowed names above
  - fieldType: the type from above
  - source: one of "heading", "text", "image", "link", "literal", "list"
      "heading" → use section.heading (the section's main heading)
      "text" → use the section body text
      "image" → set value to "0", "1", etc. for which image
      "link" → set value to "0", "1", etc. for which link
      "literal" → set value to a literal string (use sparingly)
      "list" → for repeater fields (will be auto-populated separately)
  - value: present only when source is image/link/literal
  - description: short reason

Return strictly this JSON shape, no preamble:
{
  "reasoning": "one-sentence rationale",
  "mappings": [ { fieldName, fieldType, source, value?, description }, ... ]
}`;

  let response;
  try {
    response = await callAnthropic({
      maxTokens: 2000,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    return {
      mappings: [],
      reasoning: `Field mapping call failed: ${(err as Error).message}`,
    };
  }

  const text = extractText(response);

  let parsed: { reasoning?: string; mappings?: FieldMapping[] };
  try {
    parsed = parseJsonResponse<{ reasoning?: string; mappings?: FieldMapping[] }>(text);
  } catch {
    return {
      mappings: [],
      reasoning: "Couldn't parse mapping response — module defaults will render",
    };
  }

  const allowedSet = new Set(fieldDetails.map((f) => f.name));
  const validMappings = (parsed.mappings ?? []).filter((m) => allowedSet.has(m.fieldName));

  return {
    mappings: validMappings,
    reasoning: parsed.reasoning ?? "Field mappings produced",
  };
}

// ============================================================
// Rich text fallback construction (no Claude call)
// ============================================================

function buildRichTextFallback(section: ParsedSection, pattern: SectionPattern, reasoning: string): SectionMatch {
  return {
    sectionId: section.id,
    pattern,
    matchedModule: RICH_TEXT_MODULE_NAME,
    matchedModulePath: RICH_TEXT_API_PATH,
    confidence: 1.0,
    reasoning: `Rich text fallback. ${reasoning}`,
    fieldMappings: [
      {
        fieldName: "html",
        fieldType: "richtext",
        source: "text",
        description: "Section body as rich text",
      },
    ],
    isFallback: true,
  };
}

// ============================================================
// Top-level: match all sections in a page
// ============================================================

export type MatchPageArgs = {
  apiKey: string; // kept for compatibility; callAnthropic reads env directly
  sections: ParsedSection[];
  catalog: CatalogEntry[];
  rulebook: Rulebook | null;
};

export type MatchPageResult = {
  matches: SectionMatch[];
  patterns: SectionPatternResult[];
  rulebookUsed: boolean;
};

export async function matchPageWithRulebook(args: MatchPageArgs): Promise<MatchPageResult> {
  const { apiKey, sections, catalog, rulebook } = args;

  // Step 1: classify all sections
  const patterns = await classifySections(apiKey, sections);
  const patternBySection = new Map(patterns.map((p) => [p.sectionId, p]));

  const catalogByName = new Map(catalog.map((m) => [m.name, m]));

  // Step 2: process each section sequentially
  const matches: SectionMatch[] = [];
  for (const section of sections) {
    const patternResult = patternBySection.get(section.id);
    const pattern: SectionPattern = patternResult?.pattern ?? "rich-text-fallback";

    if (pattern === "rich-text-fallback") {
      matches.push(
        buildRichTextFallback(
          section,
          pattern,
          patternResult?.reasoning ?? "No clear pattern detected"
        )
      );
      continue;
    }

    const moduleName = resolvePatternToModule(rulebook, pattern);
    if (!moduleName) {
      matches.push(
        buildRichTextFallback(
          section,
          pattern,
          `Pattern "${pattern}" has no rulebook entry`
        )
      );
      continue;
    }

    const module = catalogByName.get(moduleName);
    if (!module) {
      matches.push(
        buildRichTextFallback(
          section,
          pattern,
          `Rulebook references unknown module "${moduleName}"`
        )
      );
      continue;
    }

    let mappingResult;
    try {
      mappingResult = await mapFieldsWithRenderContext(section, module);
    } catch (err) {
      matches.push(
        buildRichTextFallback(
          section,
          pattern,
          `Field mapping failed: ${(err as Error).message}`
        )
      );
      continue;
    }

    matches.push({
      sectionId: section.id,
      pattern,
      matchedModule: module.name,
      matchedModulePath: module.apiPath ?? module.path,
      confidence: patternResult?.confidence ?? 0.5,
      reasoning: `Pattern "${pattern}" → ${module.name}. ${mappingResult.reasoning}`,
      fieldMappings: mappingResult.mappings,
      isFallback: false,
    });
  }

  return {
    matches,
    patterns,
    rulebookUsed: rulebook !== null,
  };
}