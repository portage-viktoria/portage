/**
 * Section classifier.
 *
 * Given a list of parsed sections, ask Claude to classify each one's
 * structural type and return a confidence score.
 *
 * Design choices:
 *
 * 1. **Batch the whole page in one call**, not section-by-section. The model
 *    gets better context (it can see the page's overall flow), and we save
 *    on per-call overhead. The output is a JSON array.
 *
 * 2. **Send compact inputs.** Each section gets its heading, primary text
 *    (truncated), heading hierarchy, image alt-texts, and link texts. We do
 *    NOT send raw HTML — too noisy and burns tokens.
 *
 * 3. **Constrain to a fixed taxonomy.** The model picks from an enum we define,
 *    not free-form labels. This makes downstream matching clean.
 *
 * 4. **Confidence as a number 0-1.** Forces the model to think about how sure
 *    it is rather than just emitting a label.
 */

import { callAnthropic, extractText, parseJsonResponse } from "./anthropic";

// ============================================================
// Taxonomy — must match what we use for module structural tags
// ============================================================

export const SECTION_TYPES = [
  "hero",
  "logo-strip",
  "feature-grid",
  "feature-list",
  "card-grid",
  "accordion",
  "tabs",
  "testimonial",
  "stats",
  "cta-banner",
  "gallery",
  "blog-listing",
  "rich-text",
  "form",
  "menu",
  "other",
] as const;

export type SectionType = typeof SECTION_TYPES[number];

// ============================================================
// Input types (must match what the parser produces)
// ============================================================

export type ClassifierInputSection = {
  id: string;
  heading?: string;
  text: string;
  headings: Array<{ level: number; text: string }>;
  imageCount: number;
  imageAlts: string[];
  linkTexts: string[];
  wordCount: number;
};

export type ClassifierResult = {
  id: string;
  type: SectionType;
  confidence: number;
  reasoning?: string;
};

// ============================================================
// Prompt construction
// ============================================================

const SYSTEM_PROMPT = `You are a web design analyst classifying sections of marketing pages for a CMS migration tool.

For each section you receive, identify its STRUCTURAL TYPE from this fixed list:
- "hero": opening section with large headline, subheading, often a primary CTA
- "logo-strip": row of brand/client/partner logos, usually with a label like "Trusted by"
- "feature-grid": 2-4 column grid of features, each with icon/image + heading + short text
- "feature-list": vertical list of features, each with heading + paragraph (typically a single-column flow)
- "card-grid": grid of cards (products, team members, services, blog posts) with images
- "accordion": collapsible Q&A pairs (FAQs) or stacked expandable items
- "tabs": tabbed content with multiple tab labels
- "testimonial": customer quote(s), often with name and role
- "stats": numeric stats or metrics (often "X+", "Y%", with descriptors)
- "cta-banner": call-to-action band with a single bold message and one button
- "gallery": image-heavy section, photo grid or carousel
- "blog-listing": list of blog posts with titles/dates/excerpts
- "rich-text": long-form prose content (article body, terms text)
- "form": contact form, signup form, or any form with input fields
- "menu": navigation block (NOT the global header/footer nav)
- "other": doesn't clearly fit any of the above

Also return a confidence score 0.0-1.0 reflecting how clearly the section fits its type. Use:
- 0.9+ when the section unambiguously matches a type
- 0.7-0.9 for a strong match with minor ambiguity
- 0.5-0.7 for a plausible match with real uncertainty
- below 0.5 if you're guessing

Respond with a JSON array. Each entry: {"id": "section-N", "type": "TYPE", "confidence": 0.0-1.0, "reasoning": "one short sentence"}.

Only return the JSON array, no markdown, no extra text.`;

function buildUserPrompt(sections: ClassifierInputSection[]): string {
  const parts: string[] = [];
  parts.push("Classify each of the following sections:\n");

  for (const s of sections) {
    parts.push(`--- ${s.id} ---`);
    if (s.heading) parts.push(`Heading: ${s.heading}`);
    if (s.headings.length > 0) {
      const headingList = s.headings
        .slice(0, 8)
        .map((h) => `H${h.level}: ${h.text}`)
        .join(" | ");
      parts.push(`Headings: ${headingList}`);
    }
    parts.push(`Word count: ${s.wordCount}`);
    parts.push(`Image count: ${s.imageCount}`);
    if (s.imageAlts.length > 0) {
      parts.push(`Image alts: ${s.imageAlts.slice(0, 8).join(" | ")}`);
    }
    if (s.linkTexts.length > 0) {
      parts.push(`Link texts: ${s.linkTexts.slice(0, 12).join(" | ")}`);
    }
    const truncatedText = s.text.length > 800 ? s.text.slice(0, 800) + "…" : s.text;
    parts.push(`Text:\n${truncatedText}`);
    parts.push("");
  }

  return parts.join("\n");
}

// ============================================================
// Main entry point
// ============================================================

export async function classifySections(
  sections: ClassifierInputSection[]
): Promise<ClassifierResult[]> {
  if (sections.length === 0) return [];

  const userPrompt = buildUserPrompt(sections);

  const response = await callAnthropic({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    temperature: 0,
    maxTokens: 2048,
  });

  const text = extractText(response);
  let parsed: unknown;
  try {
    parsed = parseJsonResponse<unknown>(text);
  } catch (err) {
    throw new Error(
      `Classifier returned non-JSON response: ${text.slice(0, 300)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error("Classifier response was not an array");
  }

  // Validate and normalize each result. Tolerant of extra fields and minor
  // type mismatches; strict enough to catch garbage.
  const validated: ClassifierResult[] = [];
  const validTypes = new Set<string>(SECTION_TYPES);

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : null;
    const rawType = typeof obj.type === "string" ? obj.type.toLowerCase() : null;
    const rawConfidence = typeof obj.confidence === "number" ? obj.confidence : null;
    const reasoning = typeof obj.reasoning === "string" ? obj.reasoning.trim() : undefined;

    if (!id || !rawType || rawConfidence === null) continue;
    const type = (validTypes.has(rawType) ? rawType : "other") as SectionType;
    const confidence = Math.max(0, Math.min(1, rawConfidence));

    validated.push({
      id,
      type,
      confidence,
      reasoning: reasoning || undefined,
    });
  }

  // Backfill any sections the model didn't classify, marking them as "other"
  // with low confidence.
  const seenIds = new Set(validated.map((v) => v.id));
  for (const s of sections) {
    if (!seenIds.has(s.id)) {
      validated.push({
        id: s.id,
        type: "other",
        confidence: 0,
        reasoning: "Classifier did not return a result for this section.",
      });
    }
  }

  // Order to match input order
  const order = new Map(sections.map((s, i) => [s.id, i]));
  validated.sort(
    (a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999)
  );

  return validated;
}