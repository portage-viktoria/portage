/**
 * Source content normalizer — Phase 2.
 *
 * Takes raw parsed sections from the parser (which extracts whatever HTML
 * was on the source page) and produces a canonical content shape that any
 * theme's modules can consume.
 *
 * The normalized shape captures content by INTENT, not by HTML structure:
 *
 *   {
 *     primaryHeading: "Get in Touch",
 *     secondaryHeadings: ["Why us", ...],
 *     bodyText: "...",                      // plain text version
 *     bodyRichText: "<p>...</p>",           // HTML version for richtext fields
 *     primaryImage: { src, alt, width, height },
 *     additionalImages: [...],
 *     primaryCta: { text, href, type },     // most prominent link
 *     additionalCtas: [...],
 *     // For sections classified as card-grid/feature-list, structured items
 *     items: [
 *       { heading, text, image, link },
 *       ...
 *     ]
 *   }
 *
 * The matcher consumes this normalized shape rather than the raw section.
 */

// ============================================================
// Types
// ============================================================

export type RawSection = {
  id: string;
  content: {
    heading?: string;
    text: string;
    headings: Array<{ level: number; text: string }>;
    images: Array<{ src: string; alt?: string; width?: number; height?: number }>;
    links: Array<{ text: string; href: string }>;
    wordCount: number;
    // Optional richtext html if the parser captured it
    html?: string;
  };
};

export type NormalizedImage = {
  src: string;
  alt: string;
  width?: number;
  height?: number;
};

export type NormalizedCta = {
  text: string;
  href: string;
  type: "EXTERNAL" | "EMAIL_ADDRESS" | "PHONE_NUMBER" | "CONTENT" | "FILE";
  isPhoneNumber: boolean;
  isEmail: boolean;
};

export type NormalizedItem = {
  heading?: string;
  text?: string;
  image?: NormalizedImage;
  link?: NormalizedCta;
};

export type NormalizedSection = {
  id: string;
  primaryHeading?: string;
  secondaryHeadings: string[];
  bodyText: string;
  bodyRichText: string;        // HTML for richtext fields
  primaryImage?: NormalizedImage;
  additionalImages: NormalizedImage[];
  primaryCta?: NormalizedCta;
  additionalCtas: NormalizedCta[];
  // Structured items for repeater-friendly sections
  items: NormalizedItem[];
  // Metadata
  wordCount: number;
  totalImages: number;
  totalLinks: number;
};

// ============================================================
// Helpers
// ============================================================

function normalizeImage(img: { src: string; alt?: string; width?: number; height?: number }): NormalizedImage {
  return {
    src: img.src,
    alt: img.alt ?? "",
    width: typeof img.width === "number" ? img.width : undefined,
    height: typeof img.height === "number" ? img.height : undefined,
  };
}

function normalizeLink(link: { text: string; href: string }): NormalizedCta {
  const href = link.href;
  let type: NormalizedCta["type"] = "EXTERNAL";
  let isPhoneNumber = false;
  let isEmail = false;

  if (href.startsWith("mailto:")) {
    type = "EMAIL_ADDRESS";
    isEmail = true;
  } else if (href.startsWith("tel:")) {
    type = "PHONE_NUMBER";
    isPhoneNumber = true;
  } else if (/^https?:\/\//i.test(href)) {
    type = "EXTERNAL";
  } else if (href.startsWith("/")) {
    // Relative URL — could be CONTENT but we don't know the page ID
    type = "EXTERNAL";
  }

  return {
    text: (link.text || "").trim(),
    href,
    type,
    isPhoneNumber,
    isEmail,
  };
}

/**
 * Convert plain text into minimal richtext HTML.
 * Splits on double newlines for paragraphs; preserves single newlines as <br>.
 */
function plainTextToRichText(text: string): string {
  if (!text) return "";
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ============================================================
// Card-grid / feature-list item detection
// ============================================================

/**
 * Heuristic: split a section into items if its structure suggests a card grid.
 * Returns items only if we can confidently identify >= 2 parallel items.
 *
 * Approach: if there are multiple headings of the same level (e.g. several H3s)
 * and roughly equal numbers of images and links, each heading likely starts a card.
 */
function detectItems(raw: RawSection): NormalizedItem[] {
  const headings = raw.content.headings ?? [];
  const images = raw.content.images ?? [];
  const links = raw.content.links ?? [];

  // Find the most common heading level (likely the card title level)
  const levelCounts = new Map<number, number>();
  for (const h of headings) {
    levelCounts.set(h.level, (levelCounts.get(h.level) ?? 0) + 1);
  }
  let cardLevel = 0;
  let cardCount = 0;
  for (const [level, count] of levelCounts.entries()) {
    if (count >= 2 && count > cardCount) {
      cardLevel = level;
      cardCount = count;
    }
  }

  if (cardCount < 2) return [];

  const cardHeadings = headings.filter((h) => h.level === cardLevel);
  // Don't try to be too clever — only proceed if we have a sensible layout
  if (cardHeadings.length < 2) return [];

  // Distribute images and links roughly evenly among cards
  const items: NormalizedItem[] = cardHeadings.map((h, i) => {
    const item: NormalizedItem = { heading: h.text };
    if (images[i]) item.image = normalizeImage(images[i]);
    if (links[i]) item.link = normalizeLink(links[i]);
    return item;
  });

  return items;
}

// ============================================================
// Public API
// ============================================================

export function normalizeSection(raw: RawSection): NormalizedSection {
  const headings = raw.content.headings ?? [];
  const images = raw.content.images ?? [];
  const links = raw.content.links ?? [];

  const primaryHeading =
    raw.content.heading ?? headings[0]?.text ?? undefined;

  const secondaryHeadings = headings
    .filter((h) => h.text !== primaryHeading)
    .map((h) => h.text);

  const bodyText = raw.content.text ?? "";
  const bodyRichText =
    typeof raw.content.html === "string" && raw.content.html.length > 0
      ? raw.content.html
      : plainTextToRichText(bodyText);

  const normalizedImages = images.map(normalizeImage);
  const primaryImage = normalizedImages[0];
  const additionalImages = normalizedImages.slice(1);

  const normalizedLinks = links.map(normalizeLink);
  const primaryCta = normalizedLinks[0];
  const additionalCtas = normalizedLinks.slice(1);

  const items = detectItems(raw);

  return {
    id: raw.id,
    primaryHeading,
    secondaryHeadings,
    bodyText,
    bodyRichText,
    primaryImage,
    additionalImages,
    primaryCta,
    additionalCtas,
    items,
    wordCount: raw.content.wordCount ?? 0,
    totalImages: normalizedImages.length,
    totalLinks: normalizedLinks.length,
  };
}

export function normalizeSections(rawSections: RawSection[]): NormalizedSection[] {
  return rawSections.map(normalizeSection);
}