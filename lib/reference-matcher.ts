/**
 * Reference-based matcher.
 *
 * One Claude call per page. Takes:
 *   - all parsed sections from the source page
 *   - the reference catalog (with USE WHEN rules per entry)
 *
 * Returns, per section:
 *   - entryId: which catalog entry to use (or null for rich-text fallback)
 *   - substitutions: which source fields go into which demo placeholders
 *   - reasoning: one-sentence explanation
 *
 * The matcher does NOT produce raw HubSpot params. It produces a small
 * set of substitution instructions. The publisher applies those instructions
 * to the demo content from the catalog.
 *
 * Substitution shape (Claude returns this):
 *   {
 *     useTitle: boolean,        // replace any *.title with section heading
 *     useBody: boolean,          // replace any *.supporting_content with section body
 *     primaryImageIdx?: number,  // which source image goes into the module's image (or null)
 *     primaryLinkIdx?: number,   // which source link goes into the first button/cta
 *     repeaterItems?: Array<{    // for repeater modules, parallel items from source
 *       title?: string,
 *       text?: string,
 *       imageIdx?: number,
 *       linkIdx?: number,
 *     }>
 *   }
 */

import { callAnthropic, extractText, parseJsonResponse } from "./anthropic";
import type { ReferenceCatalog, ReferenceCatalogEntry } from "./reference-catalog";

// ============================================================
// Types
// ============================================================

export type ParsedSection = {
  id: string;
  content: {
    heading?: string;
    text: string;
    headings: Array<{ level: number; text: string }>;
    images: Array<{ src: string; alt?: string }>;
    links: Array<{ text: string; href: string }>;
    wordCount: number;
  };
};

export type Substitutions = {
  useTitle: boolean;
  useBody: boolean;
  primaryImageIdx?: number | null;
  primaryLinkIdx?: number | null;
  repeaterItems?: Array<{
    title?: string;
    text?: string;
    imageIdx?: number;
    linkIdx?: number;
  }>;
};

export type SectionMatch = {
  sectionId: string;
  entryId: string | null;        // null = rich-text fallback
  matchedLabel: string;          // human-readable, e.g. "Two Column w Image"
  modulePath: string;            // module path (with project's theme name swapped in)
  confidence: number;
  reasoning: string;
  substitutions: Substitutions;
  isFallback: boolean;
};

export type MatchPageResult = {
  matches: SectionMatch[];
};

// ============================================================
// Helpers
// ============================================================

function summarizeSection(s: ParsedSection) {
  return {
    id: s.id,
    heading: s.content.heading ?? "",
    headings: s.content.headings.slice(0, 8).map((h) => `H${h.level}: ${h.text}`),
    textPreview: (s.content.text ?? "").slice(0, 500),
    wordCount: s.content.wordCount,
    images: s.content.images.slice(0, 6).map((img, i) => ({
      idx: i,
      alt: img.alt ?? "",
    })),
    links: s.content.links.slice(0, 8).map((l, i) => ({
      idx: i,
      text: l.text,
    })),
  };
}

function summarizeCatalogEntry(e: ReferenceCatalogEntry) {
  return {
    id: e.id,
    label: e.label,
    useWhen: e.useWhen,
    fields: e.mainFields,
    notes: e.notes,
  };
}

// ============================================================
// Matcher
// ============================================================

export async function matchPageWithCatalog(
  sections: ParsedSection[],
  catalog: ReferenceCatalog,
  themeName: string
): Promise<MatchPageResult> {
  if (sections.length === 0) {
    return { matches: [] };
  }

  const sectionSummaries = sections.map(summarizeSection);
  const catalogSummaries = catalog.entries.map(summarizeCatalogEntry);

  const prompt = `You're matching scraped web page sections to canonical Bluleadz module instances.

Each module instance in the catalog has a USE WHEN rule that tells you when to pick it. Read those rules carefully — they're the primary signal for matching.

CATALOG (each entry has a unique id, label, and USE WHEN rule):
${JSON.stringify(catalogSummaries, null, 2)}

SCRAPED SECTIONS:
${JSON.stringify(sectionSummaries, null, 2)}

For EACH scraped section, decide:

1. Which catalog entry id matches best, OR null for "rich-text-fallback" if nothing fits cleanly.
2. What substitutions to make from the source content into the module's structure.

Substitution rules:
- useTitle: true if the module has a heading slot AND the section has a heading worth using
- useBody: true if the module has a body/supporting_content slot AND the section has body text
- primaryImageIdx: which source image (0, 1, ...) to use as the module's primary image, or null if no image fits
- primaryLinkIdx: which source link (0, 1, ...) to use as the module's primary CTA, or null
- repeaterItems: ONLY for modules with repeaters (Icon Columns, Image Cards, Accordion, Two Column w Icon List, Image Gallery, Two Column). Each entry maps a parallel item from the source. Use the section's headings array to identify card/accordion items. Each repeaterItem has optional title, text, imageIdx, linkIdx. Provide as many items as you can identify in the source — the publisher will trim or extend the demo's repeater accordingly.

If no catalog entry fits a section cleanly, set entryId to null and the section will be rendered as rich-text fallback (using the Two Column module with body text).

Return strictly this JSON shape, no preamble:
{
  "matches": [
    {
      "sectionId": "...",
      "entryId": "..." or null,
      "confidence": 0.0-1.0,
      "reasoning": "one sentence explaining the choice",
      "substitutions": {
        "useTitle": true | false,
        "useBody": true | false,
        "primaryImageIdx": 0 | null,
        "primaryLinkIdx": 0 | null,
        "repeaterItems": [ { "title": "...", "text": "...", "imageIdx": 0, "linkIdx": 0 }, ... ]
      }
    },
    ...
  ]
}`;

  let response;
  try {
    response = await callAnthropic({
      maxTokens: 8000,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (err) {
    // If the matcher fails entirely, fall back to rich-text for everything
    return {
      matches: sections.map((s) =>
        buildFallbackMatch(s, catalog, themeName, `Matcher call failed: ${(err as Error).message}`)
      ),
    };
  }

  const text = extractText(response);

  type RawMatch = {
    sectionId?: string;
    entryId?: string | null;
    confidence?: number;
    reasoning?: string;
    substitutions?: Substitutions;
  };

  let parsed: { matches?: RawMatch[] };
  try {
    parsed = parseJsonResponse<{ matches?: RawMatch[] }>(text);
  } catch {
    return {
      matches: sections.map((s) =>
        buildFallbackMatch(s, catalog, themeName, "Couldn't parse matcher response")
      ),
    };
  }

  const matchesBySectionId = new Map<string, RawMatch>();
  for (const m of parsed.matches ?? []) {
    if (m.sectionId) matchesBySectionId.set(m.sectionId, m);
  }

  const matches: SectionMatch[] = [];
  for (const section of sections) {
    const raw = matchesBySectionId.get(section.id);

    if (!raw || !raw.entryId) {
      matches.push(buildFallbackMatch(
        section,
        catalog,
        themeName,
        raw?.reasoning ?? "No catalog entry assigned"
      ));
      continue;
    }

    const entry = catalog.entries.find((e) => e.id === raw.entryId);
    if (!entry) {
      matches.push(buildFallbackMatch(
        section,
        catalog,
        themeName,
        `Matcher referenced unknown catalog id: ${raw.entryId}`
      ));
      continue;
    }

    matches.push({
      sectionId: section.id,
      entryId: entry.id,
      matchedLabel: entry.label,
      modulePath: rewritePathForTheme(entry.path, themeName),
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0.7,
      reasoning: raw.reasoning ?? "",
      substitutions: normalizeSubstitutions(raw.substitutions),
      isFallback: false,
    });
  }

  return { matches };
}

// ============================================================
// Fallback construction
// ============================================================

const FALLBACK_ENTRY_ID = "two-column"; // The plain "Two Column" module — fallback for unmatched

function buildFallbackMatch(
  section: ParsedSection,
  catalog: ReferenceCatalog,
  themeName: string,
  reasoning: string
): SectionMatch {
  // Use the "Two Column" entry's structure for rich-text fallback.
  // If the catalog doesn't have it (shouldn't happen), pick any entry.
  const entry =
    catalog.entries.find((e) => e.id === FALLBACK_ENTRY_ID) ??
    catalog.entries[0];

  if (!entry) {
    // Truly broken — return a stub
    return {
      sectionId: section.id,
      entryId: null,
      matchedLabel: "(no fallback available)",
      modulePath: "",
      confidence: 0,
      reasoning: `Catalog is empty: ${reasoning}`,
      substitutions: { useTitle: false, useBody: false },
      isFallback: true,
    };
  }

  return {
    sectionId: section.id,
    entryId: entry.id,
    matchedLabel: `${entry.label} (fallback)`,
    modulePath: rewritePathForTheme(entry.path, themeName),
    confidence: 1.0,
    reasoning: `Rich-text fallback. ${reasoning}`,
    substitutions: {
      useTitle: !!section.content.heading,
      useBody: !!section.content.text,
      primaryImageIdx: section.content.images.length > 0 ? 0 : null,
      primaryLinkIdx: section.content.links.length > 0 ? 0 : null,
    },
    isFallback: true,
  };
}

function normalizeSubstitutions(raw: Substitutions | undefined): Substitutions {
  if (!raw) return { useTitle: false, useBody: false };
  return {
    useTitle: raw.useTitle === true,
    useBody: raw.useBody === true,
    primaryImageIdx:
      typeof raw.primaryImageIdx === "number" ? raw.primaryImageIdx : null,
    primaryLinkIdx:
      typeof raw.primaryLinkIdx === "number" ? raw.primaryLinkIdx : null,
    repeaterItems: Array.isArray(raw.repeaterItems)
      ? raw.repeaterItems.filter((i) => i && typeof i === "object")
      : undefined,
  };
}

// Re-export for use elsewhere
export function rewritePathForTheme(originalPath: string, themeName: string): string {
  const normalized = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
  const modulesIdx = normalized.indexOf("/modules/");
  if (modulesIdx === -1) return normalized;
  return `/${themeName}${normalized.slice(modulesIdx)}`;
}