/**
 * Source page parser.
 *
 * Given rendered HTML, produces a structured ParsedPage with discrete sections.
 * Each section has stripped-down content (text, headings, images, links) and
 * an identifier suitable for cross-referencing in later milestones (the
 * classifier and matcher will consume these sections directly).
 *
 * Section detection strategy — combine multiple signals:
 *   1. Top-level <section> and <main > <div> children
 *   2. Direct children of <main>, <body>, or known content wrappers
 *   3. Heading-anchored chunks (h1/h2 starts a new section)
 *   4. Class name patterns common in marketing sites (.section, .hero, etc.)
 *
 * We over-segment rather than under-segment. Better to give the user 12
 * candidate sections (some of which they merge later) than 4 (which hides
 * real boundaries). The classifier in Milestone 4 will help disambiguate.
 *
 * Uses node-html-parser — fast, dependency-free, handles real-world messy HTML.
 */

import { parse, HTMLElement, Node, NodeType } from "node-html-parser";

// ============================================================
// Types
// ============================================================

export type ExtractedImage = {
  src: string;
  alt?: string;
  width?: number;
  height?: number;
};

export type ExtractedLink = {
  text: string;
  href: string;
};

export type SectionContent = {
  // Rendered text content of the section, with block boundaries preserved
  text: string;
  // The section's primary heading, if any (h1/h2/h3 closest to the top)
  heading?: string;
  // All headings in the section, with their levels
  headings: Array<{ level: number; text: string }>;
  // All <img> tags found inside the section
  images: ExtractedImage[];
  // All <a> links found inside the section (excluding anchor-only links)
  links: ExtractedLink[];
  // Approximate number of words in the section
  wordCount: number;
};

export type DetectedSection = {
  id: string; // stable identifier within this parse: "section-1", "section-2", ...
  // The HTML of the section, normalized (inline styles stripped, etc.)
  html: string;
  // Structured content extracted from that HTML
  content: SectionContent;
  // CSS-style selector path that uniquely identifies this section in the
  // original DOM. Helpful later for cropping screenshots and for diagnostic
  // display in the UI.
  domPath: string;
  // Rough vertical position hints — useful for visualization and screenshot
  // cropping later. Both default to undefined when we can't estimate.
  approximateOrder: number;
};

export type ParsedPage = {
  sourceUrl: string;
  pageTitle?: string;
  pageDescription?: string;
  sections: DetectedSection[];
  sectionCount: number;
  warnings: string[];
  parsedAt: string; // ISO timestamp
};

// ============================================================
// HTML normalization
// ============================================================

const STRIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "iframe",
  "svg", // we keep image references via <img>, but inline SVGs are usually icons we don't need
]);

const STRIP_ATTRIBUTES = new Set([
  "style",
  "onclick",
  "onload",
  "onerror",
  "onmouseover",
  "onmouseout",
  "onfocus",
  "onblur",
  "onchange",
  "onsubmit",
  "data-hs-cf-bound",
  "data-reactid",
]);

/**
 * Walk the DOM tree, removing scripts/styles, stripping inline styles and
 * tracking attributes, and collapsing irrelevant wrapper divs.
 *
 * Mutates in place. Returns the same root for chaining.
 */
function normalizeDom(root: HTMLElement): HTMLElement {
  // Recursive cleanup
  function clean(node: HTMLElement) {
    // Iterate children in reverse so we can safely remove
    const children = node.childNodes.slice();
    for (const child of children) {
      if (child.nodeType === NodeType.COMMENT_NODE) {
        // Remove all HTML comments
        node.removeChild(child);
        continue;
      }
      if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
      const elem = child as HTMLElement;
      const tag = elem.rawTagName?.toLowerCase();

      if (tag && STRIP_TAGS.has(tag)) {
        node.removeChild(elem);
        continue;
      }

      // Strip dangerous/style attributes from this element
      const attrs = elem.attributes;
      for (const attrName of Object.keys(attrs)) {
        const lower = attrName.toLowerCase();
        if (STRIP_ATTRIBUTES.has(lower)) {
          elem.removeAttribute(attrName);
        }
        // Strip all on* event handlers as a catch-all
        if (lower.startsWith("on")) {
          elem.removeAttribute(attrName);
        }
      }

      clean(elem);
    }
  }

  clean(root);
  return root;
}

// ============================================================
// Page metadata extraction
// ============================================================

function extractPageTitle(root: HTMLElement): string | undefined {
  // Prefer <title>, fall back to og:title
  const titleEl = root.querySelector("title");
  if (titleEl?.text?.trim()) return titleEl.text.trim();

  const ogTitle = root.querySelector('meta[property="og:title"]');
  if (ogTitle) {
    const content = ogTitle.getAttribute("content")?.trim();
    if (content) return content;
  }

  const h1 = root.querySelector("h1");
  if (h1?.text?.trim()) return h1.text.trim();

  return undefined;
}

function extractPageDescription(root: HTMLElement): string | undefined {
  const meta = root.querySelector('meta[name="description"]');
  if (meta) {
    const content = meta.getAttribute("content")?.trim();
    if (content) return content;
  }
  const og = root.querySelector('meta[property="og:description"]');
  if (og) {
    const content = og.getAttribute("content")?.trim();
    if (content) return content;
  }
  return undefined;
}

// ============================================================
// Section detection
// ============================================================

const SECTION_LIKE_TAGS = new Set(["section", "article"]);

// Class names that strongly suggest "this is a section"
const SECTION_CLASS_PATTERNS = [
  /\bsection\b/i,
  /\bhero\b/i,
  /\bcta[-_]?(banner|section|band)?\b/i,
  /\bcontent[-_]?block\b/i,
  /\bcontent[-_]?section\b/i,
  /\bpage[-_]?section\b/i,
  /\brow\b/i, // common in HubSpot themes
  /\bdnd[-_]?section\b/i, // HubSpot drag-and-drop sections
  /\bspan\d{1,2}\b/i, // HubSpot column wrappers — not perfect but a signal
];

// Tags that we should NOT treat as section boundaries even if they have a
// suspicious class — these are inline or layout-only.
const NEVER_SECTION_TAGS = new Set([
  "header",
  "footer",
  "nav",
  "aside",
  "form",
  "ul",
  "ol",
  "li",
  "p",
  "span",
  "a",
  "button",
  "img",
  "br",
  "hr",
]);

function looksLikeSection(elem: HTMLElement): boolean {
  const tag = elem.rawTagName?.toLowerCase();
  if (!tag) return false;
  if (NEVER_SECTION_TAGS.has(tag)) return false;

  if (SECTION_LIKE_TAGS.has(tag)) return true;

  const className = elem.getAttribute("class") ?? "";
  if (className) {
    for (const pattern of SECTION_CLASS_PATTERNS) {
      if (pattern.test(className)) return true;
    }
  }

  return false;
}

/**
 * Find the best content root in the document. Prefer <main>, fall back to
 * <body>. Skip <header>, <nav>, <footer>, and anything that looks like a
 * site chrome wrapper.
 */
function findContentRoot(root: HTMLElement): HTMLElement {
  const main = root.querySelector("main");
  if (main) return main;
  const body = root.querySelector("body");
  if (body) return body;
  return root;
}

/**
 * Identify section candidates within a content root.
 *
 * Strategy:
 *   1. If content root has direct children that are sections (semantic or
 *      pattern-matched), use those.
 *   2. Otherwise, recurse into the first non-trivial wrapper and try again.
 *      This handles wrappers like <div class="container"><div class="row">...
 *      that nest a level or two before sections appear.
 *   3. If we still can't find sections, fall back to heading-anchored
 *      chunking — every h1/h2 starts a new section, with content collected
 *      until the next heading.
 */
function detectSectionCandidates(contentRoot: HTMLElement): HTMLElement[] {
  // Strategy 1+2: walk down looking for a level where sections appear
  let current = contentRoot;
  for (let depth = 0; depth < 4; depth++) {
    const sections: HTMLElement[] = [];
    for (const child of current.childNodes) {
      if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
      const elem = child as HTMLElement;
      if (looksLikeSection(elem)) sections.push(elem);
    }
    if (sections.length >= 2) return sections;

    // Step into the first significant child if no sections found
    const firstSignificantChild = current.childNodes
      .filter((n) => n.nodeType === NodeType.ELEMENT_NODE)
      .map((n) => n as HTMLElement)
      .find(
        (e) =>
          !["header", "footer", "nav", "aside"].includes(
            e.rawTagName?.toLowerCase() ?? ""
          )
      );
    if (!firstSignificantChild) break;
    current = firstSignificantChild;
  }

  // Strategy 3: heading-anchored chunking as a fallback
  return chunkByHeadings(contentRoot);
}

/**
 * Fallback chunker — when we can't find <section>-like wrappers, group siblings
 * by heading. Each h1/h2 starts a new chunk; a chunk includes that heading
 * plus all following non-heading siblings until the next h1/h2.
 *
 * Returns synthetic HTMLElement wrappers, one per chunk.
 */
function chunkByHeadings(contentRoot: HTMLElement): HTMLElement[] {
  // Find all top-level descendants that are headings or sibling content
  // For simplicity, look at direct children only. If a page wraps everything
  // in one big div, we go a level deeper.
  let scan = contentRoot;
  for (let depth = 0; depth < 3; depth++) {
    const headings = scan.childNodes.filter(
      (n) =>
        n.nodeType === NodeType.ELEMENT_NODE &&
        /^h[12]$/i.test((n as HTMLElement).rawTagName ?? "")
    );
    if (headings.length >= 2) break;
    const firstChild = scan.childNodes.find(
      (n) => n.nodeType === NodeType.ELEMENT_NODE
    ) as HTMLElement | undefined;
    if (!firstChild) break;
    scan = firstChild;
  }

  // Build chunks
  const chunks: HTMLElement[] = [];
  let currentChunk: HTMLElement | null = null;

  for (const child of scan.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const elem = child as HTMLElement;
    const tag = elem.rawTagName?.toLowerCase() ?? "";

    if (/^h[12]$/.test(tag)) {
      // Start a new chunk
      currentChunk = parse('<section class="portage-chunk"></section>')
        .firstChild as HTMLElement;
      currentChunk.appendChild(elem.clone());
      chunks.push(currentChunk);
    } else if (currentChunk) {
      currentChunk.appendChild(elem.clone());
    }
    // Content before the first heading is dropped — usually navigation
    // or branding that we don't want to treat as a section anyway.
  }

  return chunks;
}

// ============================================================
// Per-section content extraction
// ============================================================

function extractTextWithBreaks(elem: HTMLElement): string {
  // Get text content but preserve paragraph/list/heading boundaries as
  // newlines. node-html-parser's structuredText is okay but adds excessive
  // whitespace; we do it ourselves for cleaner output.
  const blockTags = new Set([
    "p", "div", "section", "article", "header", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "blockquote", "pre",
    "br",
  ]);

  function walk(node: Node, parts: string[]): void {
    if (node.nodeType === NodeType.TEXT_NODE) {
      const text = (node as Node & { rawText: string }).rawText;
      if (text) parts.push(text);
      return;
    }
    if (node.nodeType !== NodeType.ELEMENT_NODE) return;
    const e = node as HTMLElement;
    const tag = e.rawTagName?.toLowerCase() ?? "";
    const isBlock = blockTags.has(tag);

    if (isBlock) parts.push("\n");
    for (const child of e.childNodes) walk(child, parts);
    if (isBlock) parts.push("\n");
  }

  const parts: string[] = [];
  walk(elem, parts);
  // Collapse whitespace, preserve double-newlines as paragraph breaks
  const joined = parts.join("");
  return joined
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractHeadings(elem: HTMLElement): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  for (let level = 1; level <= 6; level++) {
    const els = elem.querySelectorAll(`h${level}`);
    for (const h of els) {
      const text = h.text?.trim();
      if (text) headings.push({ level, text });
    }
  }
  return headings;
}

function extractImages(elem: HTMLElement): ExtractedImage[] {
  const imgs: ExtractedImage[] = [];
  for (const img of elem.querySelectorAll("img")) {
    const src = img.getAttribute("src")?.trim();
    if (!src) continue;
    // Skip tracking pixels
    const width = parseInt(img.getAttribute("width") ?? "", 10);
    const height = parseInt(img.getAttribute("height") ?? "", 10);
    if (!isNaN(width) && !isNaN(height) && width <= 1 && height <= 1) continue;
    imgs.push({
      src,
      alt: img.getAttribute("alt")?.trim() || undefined,
      width: !isNaN(width) ? width : undefined,
      height: !isNaN(height) ? height : undefined,
    });
  }
  return imgs;
}

function extractLinks(elem: HTMLElement): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  for (const a of elem.querySelectorAll("a")) {
    const href = a.getAttribute("href")?.trim();
    const text = a.text?.trim();
    if (!href || !text) continue;
    if (href.startsWith("#") || href.startsWith("javascript:")) continue;
    links.push({ text, href });
  }
  return links;
}

function buildSectionContent(elem: HTMLElement): SectionContent {
  const text = extractTextWithBreaks(elem);
  const headings = extractHeadings(elem);
  const images = extractImages(elem);
  const links = extractLinks(elem);

  // Primary heading: closest h1, then h2, then h3
  let heading: string | undefined;
  for (const target of [1, 2, 3]) {
    const found = headings.find((h) => h.level === target);
    if (found) {
      heading = found.text;
      break;
    }
  }

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  return { text, heading, headings, images, links, wordCount };
}

// ============================================================
// DOM path computation (for diagnostics + future screenshot cropping)
// ============================================================

function computeDomPath(elem: HTMLElement, root: HTMLElement): string {
  const parts: string[] = [];
  let current: HTMLElement | null = elem;
  while (current && current !== root) {
    const tag = current.rawTagName?.toLowerCase() ?? "?";
    const parent = current.parentNode as HTMLElement | null;
    if (!parent) break;
    const siblings = parent.childNodes
      .filter((n) => n.nodeType === NodeType.ELEMENT_NODE)
      .map((n) => n as HTMLElement)
      .filter((e) => e.rawTagName?.toLowerCase() === tag);
    const index = siblings.indexOf(current);
    parts.unshift(`${tag}[${index}]`);
    current = parent;
  }
  return parts.join(" > ");
}

// ============================================================
// Top-level: parse a rendered HTML string into a ParsedPage
// ============================================================

const MIN_SECTION_WORDS = 5; // skip near-empty sections (likely whitespace wrappers)

export function parseSourcePage(
  sourceUrl: string,
  renderedHtml: string
): ParsedPage {
  const result: ParsedPage = {
    sourceUrl,
    sections: [],
    sectionCount: 0,
    warnings: [],
    parsedAt: new Date().toISOString(),
  };

  let root: HTMLElement;
  try {
    root = parse(renderedHtml, {
      lowerCaseTagName: false,
      comment: false,
      blockTextElements: { script: false, noscript: false, style: false, pre: true },
    });
  } catch (err) {
    result.warnings.push(`Failed to parse HTML: ${(err as Error).message}`);
    return result;
  }

  normalizeDom(root);

  result.pageTitle = extractPageTitle(root);
  result.pageDescription = extractPageDescription(root);

  const contentRoot = findContentRoot(root);
  const candidates = detectSectionCandidates(contentRoot);

  if (candidates.length === 0) {
    result.warnings.push(
      "Couldn't detect any sections. The page may have an unusual structure or be mostly empty after rendering."
    );
    return result;
  }

  // Convert each candidate into a DetectedSection, dropping ones that are too
  // small to be meaningful.
  let order = 0;
  for (const candidate of candidates) {
    const content = buildSectionContent(candidate);
    if (content.wordCount < MIN_SECTION_WORDS && content.images.length === 0) {
      continue; // skip empty/tiny sections
    }

    const html = candidate.toString();
    const domPath = computeDomPath(candidate, root);

    result.sections.push({
      id: `section-${order + 1}`,
      html,
      content,
      domPath,
      approximateOrder: order,
    });
    order += 1;
  }

  result.sectionCount = result.sections.length;

  if (result.sections.length === 0) {
    result.warnings.push(
      "Found section candidates but all were below the minimum content threshold."
    );
  }

  return result;
}