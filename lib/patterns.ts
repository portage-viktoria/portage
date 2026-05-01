/**
 * Section pattern taxonomy.
 *
 * The 12 canonical patterns the classifier maps sections into, and that
 * the rulebook editor uses to let developers assign canonical modules.
 *
 * The order here is the order they appear in the rulebook editor.
 */

export type SectionPattern =
  | "hero"
  | "text-image"
  | "text-only"
  | "two-column"
  | "card-grid"
  | "accordion"
  | "cta-banner"
  | "logo-strip"
  | "testimonial"
  | "stats"
  | "gallery"
  | "rich-text-fallback";

export type PatternDefinition = {
  id: SectionPattern;
  label: string;
  description: string;
  hint: string; // shown in rulebook editor as guidance
  classifierExamples: string; // examples passed to classifier
};

export const PATTERNS: PatternDefinition[] = [
  {
    id: "hero",
    label: "Hero",
    description: "Page header with prominent headline and often an image or background",
    hint: "Pick a hero module that's NOT a slider — the migration will populate one slide's worth of content",
    classifierExamples:
      "A large attention-grabbing section at the top of a page, usually with a big headline, supporting subhead, and often a CTA or background image.",
  },
  {
    id: "text-image",
    label: "Text + image",
    description: "Content section with text on one side and an image on the other",
    hint: "A two-up layout where text and image are side-by-side. Either order is fine.",
    classifierExamples:
      "A section with one main heading, a paragraph or two of body text, and a single supporting image. Image is on either the left or right.",
  },
  {
    id: "text-only",
    label: "Text only",
    description: "Heading and body text, no image",
    hint: "For sections that are pure copy with no supporting visuals.",
    classifierExamples:
      "A section with a heading and body text but no images. May have one or two links inline.",
  },
  {
    id: "two-column",
    label: "Two column",
    description: "Two parallel content blocks side by side",
    hint: "Different from text-image: two roughly equal text blocks, or two text+image blocks side by side.",
    classifierExamples:
      "A section split into two equal columns of content, often with two headings at the same level and parallel structure.",
  },
  {
    id: "card-grid",
    label: "Card grid",
    description: "Multiple parallel items (3+ cards with heading/text/image)",
    hint: "Pick a module with a repeater for cards. The migration will split the source into individual card items.",
    classifierExamples:
      "A grid or row of 3 or more cards. Each card has its own heading and short text, sometimes an icon or image.",
  },
  {
    id: "accordion",
    label: "Accordion / FAQ",
    description: "Expandable heading + body pairs",
    hint: "Pick a module with a repeater for accordion items. The migration will split the source into individual question/answer pairs.",
    classifierExamples:
      "A list of headings each followed by a paragraph of body text — typically FAQ or expandable Q&A format.",
  },
  {
    id: "cta-banner",
    label: "CTA banner",
    description: "Short heading + button, usually full-width emphasis",
    hint: "A standalone call-to-action section, often with a background color or image and a single primary button.",
    classifierExamples:
      "A short, emphasized section with a headline and one primary button. Minimal body text. Designed to grab attention and drive action.",
  },
  {
    id: "logo-strip",
    label: "Logo strip",
    description: "Row of brand or client logos",
    hint: "The migration will populate the repeater with each logo image from the source.",
    classifierExamples:
      "A horizontal row of brand logos or client logos. Usually labeled 'As seen in', 'Trusted by', 'Our partners', etc.",
  },
  {
    id: "testimonial",
    label: "Testimonial",
    description: "Quote with attribution",
    hint: "Note: testimonials are hard to auto-populate from source HTML. Repeaters will likely stay empty.",
    classifierExamples:
      "A section with one or more customer quotes, each with author name, sometimes a title or company.",
  },
  {
    id: "stats",
    label: "Stats / numbers",
    description: "Numeric callouts with labels",
    hint: "Note: stat repeaters are hard to auto-populate. The migration may leave the repeater empty.",
    classifierExamples:
      "A section showing 2-4 large numbers (e.g. '95%', '500+', '$2M') with short labels underneath.",
  },
  {
    id: "gallery",
    label: "Gallery",
    description: "Image grid without significant text",
    hint: "Multiple images displayed as a grid, usually with little or no text.",
    classifierExamples:
      "A section that's primarily a grid of images. Minimal text, focus is on visuals.",
  },
  {
    id: "rich-text-fallback",
    label: "Rich text (fallback)",
    description: "Anything else — dumped into HubSpot's built-in rich text module",
    hint: "This is automatic. You don't need to assign a module; sections that don't fit any other pattern fall back to @hubspot/rich_text.",
    classifierExamples: "",
  },
];

export const PATTERN_IDS = PATTERNS.map((p) => p.id);

export function getPatternDefinition(id: string): PatternDefinition | null {
  return PATTERNS.find((p) => p.id === id) ?? null;
}