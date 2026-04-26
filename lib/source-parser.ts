/**
 * Source page parser — v2.
 *
 * Section detection strategy: heading-anchored chunking as the primary path,
 * because headings are the most universal signal across CMS platforms. We
 * look at every <h1> and <h2> in the main content area; each one anchors a
 * new section. Content between two anchors becomes one section.
 *
 * For each heading anchor, we determine the section's "container element" by
 * walking up the DOM from the heading until we find a parent that's likely
 * a section wrapper. Then we collect that wrapper's content.
 *
 * This handles the common case (WordPress, HubSpot, Webflow, hand-coded) and
 * works regardless of how deeply the DOM is nested. It's also tolerant of
 * weird wrapper class names because it doesn't rely on them at all.
 *
 * Falls back to top-level container detection only if no <h1>/<h2> exist.
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
  text: string;
  heading?: string;
  headings: Array<{ level: number; text: string }>;
  images: ExtractedImage[];
  links: ExtractedLink[];
  wordCount: number;
};

export type DetectedSection = {
  id: string;
  html: string;
  content: SectionContent;
  domPath: string;
  approximateOrder: number;
};

export type ParsedPage = {
  sourceUrl: string;
  pageTitle?: string;
  pageDescription?: string;
  sections: DetectedSection[];
  sectionCount: number;
  warnings: string[];
  parsedAt: string;
};

// ============================================================
// HTML normalization (unchanged from v1)
// ============================================================

const STRIP_TAGS = new Set(["script", "style", "noscript", "iframe", "svg"]);
const STRIP_ATTRIBUTES = new Set([
  "style", "onclick", "onload", "onerror", "onmouseover", "onmouseout",
  "onfocus", "onblur", "onchange", "onsubmit",
  "data-hs-cf-bound", "data-reactid",
]);

function normalizeDom(root: HTMLElement): HTMLElement {
  function clean(node: HTMLElement) {
    const children = node.childNodes.slice();
    for (const child of children) {
      if (child.nodeType === NodeType.COMMENT_NODE) {
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

      const attrs = elem.attributes;
      for (const attrName of Object.keys(attrs)) {
        const lower = attrName.toLowerCase();
        if (STRIP_ATTRIBUTES.has(lower) || lower.startsWith("on")) {
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
// Page metadata
// ============================================================

function extractPageTitle(root: HTMLElement): string | undefined {
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
// Content root detection
// ============================================================

const CHROME_TAGS = new Set(["header", "footer", "nav", "aside"]);

/**
 * Find the main content root, skipping site chrome.
 * Prefer <main>, then <body>, but exclude obvious headers/footers.
 */
function findContentRoot(root: HTMLElement): HTMLElement {
  const main = root.querySelector("main");
  if (main) return main;
  const body = root.querySelector("body");
  if (body) return body;
  return root;
}

/**
 * Check if an element is inside site chrome (header/footer/nav).
 * We don't want headings inside the navigation menu treated as section anchors.
 */
function isInsideChrome(elem: HTMLElement, contentRoot: HTMLElement): boolean {
  let current: HTMLElement | null = elem.parentNode as HTMLElement | null;
  while (current && current !== contentRoot) {
    const tag = current.rawTagName?.toLowerCase();
    if (tag && CHROME_TAGS.has(tag)) return true;
    // Also check role attribute
    const role = current.getAttribute("role")?.toLowerCase();
    if (role === "navigation" || role === "banner" || role === "contentinfo") return true;
    current = current.parentNode as HTMLElement | null;
  }
  return false;
}

// ============================================================
// Heading-anchored section detection (the new primary strategy)
// ============================================================

/**
 * Find all <h1> and <h2> elements that should anchor a section.
 * Filters out headings inside chrome (navigation menus, footers).
 */
function findSectionAnchors(contentRoot: HTMLElement): HTMLElement[] {
  const all: HTMLElement[] = [];
  const h1s = contentRoot.querySelectorAll("h1");
  const h2s = contentRoot.querySelectorAll("h2");
  for (const h of [...h1s, ...h2s]) {
    if (!isInsideChrome(h, contentRoot)) {
      const text = h.text?.trim();
      // Skip empty headings (yes, real pages have these — usually decorative)
      if (text && text.length > 0) {
        all.push(h);
      }
    }
  }
  // Sort by document order (their position in the rendered HTML)
  all.sort((a, b) => documentOrder(a, b));
  return all;
}

/**
 * Compare two elements by document order.
 * Walks the DOM to find which comes first.
 */
function documentOrder(a: HTMLElement, b: HTMLElement): number {
  // Build the path from each element to the root
  const pathA = pathToRoot(a);
  const pathB = pathToRoot(b);
  // Walk down the common ancestor and compare child indices
  let i = pathA.length - 1;
  let j = pathB.length - 1;
  while (i >= 0 && j >= 0 && pathA[i] === pathB[j]) {
    i--;
    j--;
  }
  if (i < 0) return -1; // a is ancestor of b
  if (j < 0) return 1; // b is ancestor of a
  // Different siblings under a common parent — compare their positions
  const parent = pathA[i + 1];
  if (!parent) return 0;
  const children = parent.childNodes;
  const indexA = children.indexOf(pathA[i]);
  const indexB = children.indexOf(pathB[j]);
  return indexA - indexB;
}

function pathToRoot(elem: HTMLElement): HTMLElement[] {
  const path: HTMLElement[] = [];
  let current: HTMLElement | null = elem;
  while (current) {
    path.push(current);
    current = current.parentNode as HTMLElement | null;
  }
  return path;
}

/**
 * Given a heading anchor, find the section container that "owns" it.
 *
 * Walk up the DOM from the heading. The container is the first ancestor that
 * either:
 *  - Is a semantic <section> or <article>
 *  - Has a class that strongly suggests a section
 *  - Is a div whose siblings (at the same level) also contain headings of the
 *    same level (suggesting it's a sibling-level section wrapper)
 *
 * Caps at 8 levels of walking up to avoid runaway.
 */
function findSectionContainer(heading: HTMLElement, contentRoot: HTMLElement): HTMLElement {
  const SECTION_CLASS_PATTERNS = [
    /\bsection\b/i,
    /\bhero\b/i,
    /\bdnd[-_]?section\b/i,
    /\brow[-_]?fluid[-_]?wrapper\b/i,
    /\bcontent[-_]?wrapper\b/i,
    /\bblock\b/i,
  ];
  const SECTION_TAGS = new Set(["section", "article"]);

  let current: HTMLElement | null = heading.parentNode as HTMLElement | null;
  let depth = 0;
  let bestCandidate: HTMLElement = heading;

  while (current && current !== contentRoot && depth < 8) {
    const tag = current.rawTagName?.toLowerCase();
    if (tag && SECTION_TAGS.has(tag)) return current;

    const className = current.getAttribute("class") ?? "";
    for (const pattern of SECTION_CLASS_PATTERNS) {
      if (pattern.test(className)) {
        bestCandidate = current;
        // Don't return immediately — keep walking; sometimes a more specific
        // wrapper exists higher up. But cap our walk.
        break;
      }
    }

    current = current.parentNode as HTMLElement | null;
    depth++;
  }

  return bestCandidate;
}

/**
 * Heading-anchored section detection.
 *
 * 1. Find all H1/H2 anchors in the content root, skipping chrome
 * 2. For each anchor, find its section container (walking up the DOM)
 * 3. Build sections by collecting content from each container, plus any content
 *    between containers in document order
 * 4. Capture pre-first-anchor content as the hero section if substantial
 */
function detectSectionsByHeadings(contentRoot: HTMLElement): {
  sections: HTMLElement[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const anchors = findSectionAnchors(contentRoot);

  if (anchors.length === 0) {
    warnings.push("No H1 or H2 headings found in main content.");
    return { sections: [], warnings };
  }

  // Determine each anchor's container
  const sectionContainers: HTMLElement[] = [];
  const seenContainers = new Set<HTMLElement>();

  for (const anchor of anchors) {
    const container = findSectionContainer(anchor, contentRoot);
    if (!seenContainers.has(container)) {
      sectionContainers.push(container);
      seenContainers.add(container);
    }
  }

  // If multiple anchors landed on the same container (the heading walking
  // returned a too-broad parent), fall back to using the heading itself as
  // the anchor and synthesize sections from heading-to-heading content.
  if (sectionContainers.length < anchors.length / 2 && anchors.length > 1) {
    warnings.push(
      "Container detection collapsed multiple sections together; using heading-to-heading chunks instead."
    );
    return {
      sections: chunkBetweenAnchors(anchors, contentRoot),
      warnings,
    };
  }

  return { sections: sectionContainers, warnings };
}

/**
 * Fallback: when the container walk groups too many sections together, build
 * synthetic sections by collecting siblings between adjacent heading anchors.
 *
 * This requires that the headings share a common ancestor where they're
 * siblings (or near-siblings). For each pair of adjacent anchors, find the
 * common ancestor and grab the children between them.
 */
function chunkBetweenAnchors(
  anchors: HTMLElement[],
  contentRoot: HTMLElement
): HTMLElement[] {
  const sections: HTMLElement[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const start = anchors[i];
    const end = anchors[i + 1] ?? null;

    // Build a synthetic wrapper containing the heading and everything that
    // follows it in document order until the next heading (exclusive).
    const wrapper = parse('<section class="portage-chunk"></section>')
      .firstChild as HTMLElement;
    wrapper.appendChild(start.clone());

    // Collect all elements that come after `start` in document order but
    // before `end`, scanning from start's parent and walking forward.
    let current: HTMLElement | Node | null = nextInDocumentOrder(start);
    while (current && current !== end) {
      if (current.nodeType === NodeType.ELEMENT_NODE) {
        const elem = current as HTMLElement;
        // Don't recurse into chrome
        if (!isInsideChrome(elem, contentRoot)) {
          // Avoid grabbing ancestors of `end` — that would include content
          // belonging to the next section
          if (!end || !contains(elem, end)) {
            // Only include leaf-ish content (paragraphs, lists, images, divs
            // that don't contain headings)
            if (!containsHeading(elem) && !isAncestorOfNextAnchor(elem, end)) {
              wrapper.appendChild(elem.clone());
            }
          }
        }
      }
      current = nextInDocumentOrder(current);
    }

    sections.push(wrapper);
  }

  return sections;
}

function contains(ancestor: HTMLElement, descendant: HTMLElement): boolean {
  let current: HTMLElement | null = descendant.parentNode as HTMLElement | null;
  while (current) {
    if (current === ancestor) return true;
    current = current.parentNode as HTMLElement | null;
  }
  return false;
}

function containsHeading(elem: HTMLElement): boolean {
  if (/^h[12]$/i.test(elem.rawTagName ?? "")) return true;
  return elem.querySelectorAll("h1, h2").length > 0;
}

function isAncestorOfNextAnchor(elem: HTMLElement, next: HTMLElement | null): boolean {
  if (!next) return false;
  return contains(elem, next);
}

function nextInDocumentOrder(node: Node | HTMLElement | null): HTMLElement | Node | null {
  if (!node) return null;
  const elem = node as HTMLElement;
  // First child if any
  if (elem.childNodes && elem.childNodes.length > 0) return elem.childNodes[0];
  // Otherwise next sibling, walking up if needed
  let current: HTMLElement | Node | null = node;
  while (current) {
    const parent = (current as HTMLElement).parentNode as HTMLElement | null;
    if (!parent) return null;
    const siblings = parent.childNodes;
    const idx = siblings.indexOf(current as HTMLElement);
    if (idx >= 0 && idx < siblings.length - 1) return siblings[idx + 1];
    current = parent;
  }
  return null;
}

// ============================================================
// Per-section content extraction (largely unchanged)
// ============================================================

function extractTextWithBreaks(elem: HTMLElement): string {
  const blockTags = new Set([
    "p", "div", "section", "article", "header", "footer",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li",
    "blockquote", "pre", "br",
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
// Top-level
// ============================================================

const MIN_SECTION_WORDS = 3; // lowered from 5 — a hero with just a headline + short tagline counts

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
  const { sections: candidates, warnings } = detectSectionsByHeadings(contentRoot);
  result.warnings.push(...warnings);

  if (candidates.length === 0) {
    result.warnings.push(
      "No sections detected. The page may have an unusual structure."
    );
    return result;
  }

  let order = 0;
  for (const candidate of candidates) {
    const content = buildSectionContent(candidate);
    if (content.wordCount < MIN_SECTION_WORDS && content.images.length === 0) {
      continue;
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