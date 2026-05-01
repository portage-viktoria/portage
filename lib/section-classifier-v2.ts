/**
 * Section pattern classifier.
 *
 * Categorizes each section into one of the canonical patterns from
 * lib/patterns.ts. One Claude call processes all sections of a page
 * at once (cheap and consistent).
 *
 * Returns a pattern label per section. The matcher then uses the
 * rulebook to look up the canonical module for that pattern.
 */

import { callAnthropic, extractText, parseJsonResponse } from "./anthropic";
import { PATTERNS, PATTERN_IDS, type SectionPattern } from "./patterns";

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

export type SectionPatternResult = {
  sectionId: string;
  pattern: SectionPattern;
  confidence: number;
  reasoning: string;
};

function summarizeSection(s: ParsedSection) {
  return {
    id: s.id,
    heading: s.content.heading ?? "",
    headingCount: s.content.headings.length,
    headingLevels: s.content.headings.map((h) => h.level),
    headingTexts: s.content.headings.slice(0, 6).map((h) => h.text),
    wordCount: s.content.wordCount,
    imageCount: s.content.images.length,
    linkCount: s.content.links.length,
    sampleLinks: s.content.links.slice(0, 4).map((l) => l.text),
    textPreview: (s.content.text ?? "").slice(0, 400),
  };
}

export async function classifySections(
  _apiKey: string, // kept for compatibility; callAnthropic reads env directly
  sections: ParsedSection[]
): Promise<SectionPatternResult[]> {
  if (sections.length === 0) return [];

  const summaries = sections.map(summarizeSection);

  const patternList = PATTERNS
    .filter((p) => p.id !== "rich-text-fallback") // fallback is implicit
    .map((p) => `  - "${p.id}": ${p.classifierExamples}`)
    .join("\n");

  const prompt = `You're classifying sections of a web page into canonical content patterns. Your output drives an automated migration tool, so be consistent and conservative.

PATTERNS (use exact IDs):
${patternList}
  - "rich-text-fallback": anything that doesn't clearly fit one of the above patterns (mixed content, unique layouts, etc.)

For each section below, pick exactly ONE pattern. Lean toward "rich-text-fallback" when uncertain — better to have rich text than a wrong pattern.

SECTIONS:
${JSON.stringify(summaries, null, 2)}

Return strictly this JSON shape, no preamble or commentary:
{
  "sections": [
    { "sectionId": "...", "pattern": "...", "confidence": 0.0-1.0, "reasoning": "one sentence" },
    ...
  ]
}`;

  let response;
  try {
    response = await callAnthropic({
      maxTokens: 4000,
      messages: [{ role: "user", content: prompt }],
    });
  } catch {
    // Couldn't reach Claude — assign rich-text-fallback to all
    return sections.map((s) => ({
      sectionId: s.id,
      pattern: "rich-text-fallback" as SectionPattern,
      confidence: 0.0,
      reasoning: "Classification call failed",
    }));
  }

  const text = extractText(response);

  let parsed: { sections?: SectionPatternResult[] };
  try {
    parsed = parseJsonResponse<{ sections?: SectionPatternResult[] }>(text);
  } catch {
    return sections.map((s) => ({
      sectionId: s.id,
      pattern: "rich-text-fallback" as SectionPattern,
      confidence: 0.0,
      reasoning: "Classification response couldn't be parsed",
    }));
  }

  const validPatterns = new Set<string>(PATTERN_IDS);
  const results: SectionPatternResult[] = [];
  for (const s of sections) {
    const found = parsed.sections?.find((r) => r.sectionId === s.id);
    if (found && validPatterns.has(found.pattern)) {
      results.push({
        sectionId: s.id,
        pattern: found.pattern,
        confidence: typeof found.confidence === "number" ? found.confidence : 0.5,
        reasoning: found.reasoning ?? "",
      });
    } else {
      results.push({
        sectionId: s.id,
        pattern: "rich-text-fallback",
        confidence: 0.0,
        reasoning: "Pattern not assigned — falling back to rich text",
      });
    }
  }

  return results;
}