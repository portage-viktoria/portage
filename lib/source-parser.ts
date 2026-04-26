/**
 * Source page parser — v3.
 *
 * Section detection by structural-repetition scoring.
 *
 * Key insight: on essentially every modern page (HubSpot, Webflow, Framer,
 * WordPress, hand-coded), there exists exactly one DOM level where the
 * children are the sections we want. Above that level is site chrome and
 * wrapper divs; below it are the contents of individual sections (including
 * repeaters that we should NOT treat as separate sections).
 *
 * We find that level by walking the DOM and scoring each potential level on:
 *   1. Child count fitness — pages typically have 4-30 sections
 *   2. Structural similarity — sections at the same level have similar shapes
 *   3. Class-name repetition — page builders generate consistent classes per section
 *   4. Content coverage — the level should cover most visible content
 *
 * The level with the highest combined score wins. Each child becomes a section.
 *
 * Falls back to heading-anchored chunking only if no level scores well —
 * which would happen for pages with weird hand-rolled structure.
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
  // Diagnostic: how the section was detected, useful for debugging
  detectionMethod: "structural" | "heading-fallback" | "semantic-section";
};

export type ParsedPage = {
  sourceUrl: string;
  pageTitle?: string;
  pageDescription?: string;
  sections: DetectedSection[];
  sectionCount: number;
  warnings: string[];
  detectionMethod: "structural" | "heading-fallback" | "semantic-section" | "none";
  parsedAt: string;
};

// ============================================================
// HTML normalization
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
// Content root
// ============================================================

const CHROME_TAGS = new Set(["header", "footer", "nav", "aside"]);

function findContentRoot(root: HTMLElement): HTMLElement {
  const main = root.querySelector("main");
  if (main) return main;
  const body = root.querySelector("body");
  if (body) return body;
  return root;
}

/**
 * Get the "real" children of an element, filtered to:
 *  - Only element nodes
 *  - Not site chrome (header/footer/nav)
 *  - Not empty/whitespace
 */
function meaningfulChildren(elem: HTMLElement): HTMLElement[] {
  const result: HTMLElement[] = [];
  for (const child of elem.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const c = child as HTMLElement;
    const tag = c.rawTagName?.toLowerCase() ?? "";
    if (CHROME_TAGS.has(tag)) continue;
    const role = c.getAttribute("role")?.toLowerCase();
    if (role === "navigation" || role === "banner" || role === "contentinfo") continue;
    // Skip empty wrappers with no text and no images
    const text = c.text?.trim() ?? "";
    const hasImg = c.querySelectorAll("img").length > 0;
    if (text.length === 0 && !hasImg) continue;
    result.push(c);
  }
  return result;
}

// ============================================================
// Structural scoring — the heart of detection
// ============================================================

type LevelCandidate = {
  parent: HTMLElement;
  children: HTMLElement[];
  depth: number; // depth from content root
  score: number;
  signals: {
    countScore: number;
    similarityScore: number;
    classRepetitionScore: number;
    coverageScore: number;
  };
};

/**
 * Score how well a child count fits the "real section count" expectation.
 * Most pages have between 4 and 20 sections; we peak around 8-12.
 *
 * Returns a score between 0 and 1.
 */
function scoreChildCount(count: number): number {
  if (count < 2) return 0; // a level with 0 or 1 children is never a section level
  if (count === 2) return 0.3;
  if (count === 3) return 0.5;
  if (count >= 4 && count <= 20) return 1.0;
  if (count <= 30) return 0.7;
  if (count <= 50) return 0.3;
  return 0.1; // 50+ children is almost certainly a list/grid, not sections
}

/**
 * Compute how structurally similar the children are.
 *
 * For each child, we estimate "size" by counting its descendant elements and
 * total text length. Sections at the same level should be roughly comparable.
 * We compute the coefficient of variation; lower variation = higher similarity.
 *
 * Returns a score between 0 and 1.
 */
function scoreStructuralSimilarity(children: HTMLElement[]): number {
  if (children.length < 2) return 0;

  const sizes = children.map((c) => {
    const descendantCount = c.querySelectorAll("*").length;
    const textLength = (c.text ?? "").length;
    // Combined size signal: descendants + text length / 50 (so they're comparable)
    return descendantCount + Math.floor(textLength / 50);
  });

  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  if (mean === 0) return 0;

  const variance = sizes.reduce((sum, s) => sum + (s - mean) ** 2, 0) / sizes.length;
  const stdDev = Math.sqrt(variance);
  const coefficientOfVariation = stdDev / mean;

  // CV near 0 = identical sizes; CV near 1+ = wildly different
  // Map CV → score: CV=0 → 1.0, CV=0.5 → 0.5, CV>=1.5 → 0
  if (coefficientOfVariation >= 1.5) return 0;
  return Math.max(0, 1 - coefficientOfVariation / 1.5);
}

/**
 * Compute how repetitive the children's class names are.
 *
 * Strong signals:
 *  - All children share the same outer class (e.g., all .dnd-section)
 *  - All children share a class prefix (e.g., all .section_*)
 *
 * Returns a score between 0 and 1.
 */
function scoreClassRepetition(children: HTMLElement[]): number {
  if (children.length < 2) return 0;

  const classLists = children.map((c) => {
    const cls = c.getAttribute("class") ?? "";
    return cls
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  });

  // Score 1: how many children share at least one common class?
  const allClasses = classLists.flat();
  const classCounts = new Map<string, number>();
  for (const c of allClasses) classCounts.set(c, (classCounts.get(c) ?? 0) + 1);

  let mostCommonClassCount = 0;
  for (const count of classCounts.values()) {
    if (count > mostCommonClassCount) mostCommonClassCount = count;
  }
  const sharedClassRatio = mostCommonClassCount / children.length;

  // Score 2: how many children share a class prefix? (e.g., section_hero, section_about)
  const prefixCounts = new Map<string, number>();
  for (const classes of classLists) {
    const prefixes = new Set<string>();
    for (const c of classes) {
      const match = c.match(/^([a-zA-Z][a-zA-Z0-9]*[-_])/);
      if (match) prefixes.add(match[1]);
    }
    for (const p of prefixes) prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }

  let mostCommonPrefixCount = 0;
  for (const count of prefixCounts.values()) {
    if (count > mostCommonPrefixCount) mostCommonPrefixCount = count;
  }
  const sharedPrefixRatio = mostCommonPrefixCount / children.length;

  // Score 3: tag uniformity (all <section>, all <div>)
  const tags = children.map((c) => c.rawTagName?.toLowerCase() ?? "");
  const tagCounts = new Map<string, number>();
  for (const t of tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
  let mostCommonTagCount = 0;
  for (const count of tagCounts.values()) {
    if (count > mostCommonTagCount) mostCommonTagCount = count;
  }
  const tagUniformity = mostCommonTagCount / children.length;

  // Combine: a strong signal is shared class > 0.7, prefix > 0.7, or tag uniformity 1.0
  // Take the max of these — we don't need ALL signals, any one is sufficient
  return Math.max(sharedClassRatio, sharedPrefixRatio, tagUniformity * 0.6);
}

/**
 * Compute what fraction of the page's text content is covered by these children.
 *
 * If the children together contain most of the page's text, this is likely the
 * section level. If they cover only a sliver, we're probably looking at a
 * sidebar or some other partial level.
 *
 * Returns a score between 0 and 1.
 */
function scoreContentCoverage(
  children: HTMLElement[],
  contentRoot: HTMLElement
): number {
  const totalTextLength = (contentRoot.text ?? "").length;
  if (totalTextLength === 0) return 0;

  let childrenTextLength = 0;
  for (const c of children) {
    childrenTextLength += (c.text ?? "").length;
  }

  const ratio = childrenTextLength / totalTextLength;
  // Scale: 0% = 0, 50% = 0.5, 80%+ = 1.0
  if (ratio >= 0.8) return 1.0;
  return ratio / 0.8;
}

/**
 * Score a level candidate by combining its signals.
 *
 * Weights chosen so that:
 *  - Class repetition is strongest single signal (page builders are reliable)
 *  - Child count and similarity confirm it's a real section level
 *  - Content coverage prevents picking a sidebar-like level
 */
function scoreLevel(
  parent: HTMLElement,
  children: HTMLElement[],
  contentRoot: HTMLElement,
  depth: number
): LevelCandidate {
  const countScore = scoreChildCount(children.length);
  const similarityScore = scoreStructuralSimilarity(children);
  const classRepetitionScore = scoreClassRepetition(children);
  const coverageScore = scoreContentCoverage(children, contentRoot);

  // Weights: tuned to favor levels with consistent class/tag patterns and
  // good coverage, while still working on pages without page-builder classes.
  const weighted =
    countScore * 0.25 +
    similarityScore * 0.20 +
    classRepetitionScore * 0.30 +
    coverageScore * 0.25;

  // Apply a depth penalty: shallower is generally preferred all else equal,
  // because the section level shouldn't be deeply buried. But the penalty
  // is small — a clearly better level deeper in the tree should still win.
  const depthPenalty = Math.max(0, 1 - depth * 0.05);
  const finalScore = weighted * depthPenalty;

  return {
    parent,
    children,
    depth,
    score: finalScore,
    signals: {
      countScore,
      similarityScore,
      classRepetitionScore,
      coverageScore,
    },
  };
}

/**
 * Walk the DOM from the content root, evaluating every potential section level
 * up to a max depth. Returns all candidates sorted by score, highest first.
 */
function findCandidateLevels(
  contentRoot: HTMLElement,
  maxDepth = 6
): LevelCandidate[] {
  const candidates: LevelCandidate[] = [];

  function walk(elem: HTMLElement, depth: number) {
    if (depth > maxDepth) return;
    const children = meaningfulChildren(elem);
    if (children.length >= 2) {
      candidates.push(scoreLevel(elem, children, contentRoot, depth));
    }
    // Recurse into each child IF it has its own meaningful children
    // We don't need to recurse into every descendant — only ones that could
    // themselves be section parents. A reasonable heuristic: recurse into a
    // child if it has 2+ meaningful children of its own.
    for (const child of children) {
      if (meaningfulChildren(child).length >= 2) {
        walk(child, depth + 1);
      }
    }
  }

  walk(contentRoot, 0);
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ============================================================
// Heading-anchored fallback (kept for pages without clear structure)
// ============================================================

function findHeadingFallbackSections(contentRoot: HTMLElement): HTMLElement[] {
  const anchors: HTMLElement[] = [];
  const all = [...contentRoot.querySelectorAll("h1"), ...contentRoot.querySelectorAll("h2")];
  for (const h of all) {
    if (isInsideChrome(h, contentRoot)) continue;
    if ((h.text?.trim() ?? "").length === 0) continue;
    anchors.push(h);
  }

  if (anchors.length === 0) return [];

  // Build a synthetic wrapper per heading containing the heading + content
  // until the next heading (skipping anything we can't safely include).
  const sections: HTMLElement[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const wrapper = parse('<section class="portage-heading-chunk"></section>')
      .firstChild as HTMLElement;
    wrapper.appendChild(anchors[i].clone());
    sections.push(wrapper);
  }
  return sections;
}

function isInsideChrome(elem: HTMLElement, contentRoot: HTMLElement): boolean {
  let current: HTMLElement | null = elem.parentNode as HTMLElement | null;
  while (current && current !== contentRoot) {
    const tag = current.rawTagName?.toLowerCase();
    if (tag && CHROME_TAGS.has(tag)) return true;
    const role = current.getAttribute("role")?.toLowerCase();
    if (role === "navigation" || role === "banner" || role === "contentinfo") return true;
    current = current.parentNode as HTMLElement | null;
  }
  return false;
}

// ============================================================
// Per-section content extraction
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

const MIN_SECTION_WORDS = 3;
const MIN_LEVEL_SCORE = 0.35; // below this, structural detection wasn't confident enough

export function parseSourcePage(
  sourceUrl: string,
  renderedHtml: string
): ParsedPage {
  const result: ParsedPage = {
    sourceUrl,
    sections: [],
    sectionCount: 0,
    warnings: [],
    detectionMethod: "none",
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

  // Step 1: try structural detection
  const candidates = findCandidateLevels(contentRoot);

  let detectedSections: HTMLElement[] = [];
  let method: "structural" | "heading-fallback" | "semantic-section" | "none" = "none";

  if (candidates.length > 0 && candidates[0].score >= MIN_LEVEL_SCORE) {
    const winner = candidates[0];
    detectedSections = winner.children;
    method = "structural";
    result.warnings.push(
      `Detected ${winner.children.length} sections at depth ${winner.depth} ` +
      `(score ${winner.score.toFixed(2)}; class repetition ${winner.signals.classRepetitionScore.toFixed(2)}, ` +
      `similarity ${winner.signals.similarityScore.toFixed(2)}, coverage ${winner.signals.coverageScore.toFixed(2)}).`
    );
  } else {
    // Step 2: structural detection didn't find a clear section level
    // Try semantic <section> tags directly under content root
    const semanticSections = contentRoot
      .querySelectorAll("section")
      .filter((s) => !isInsideChrome(s, contentRoot));
    if (semanticSections.length >= 2) {
      detectedSections = semanticSections;
      method = "semantic-section";
      result.warnings.push(
        `Structural detection didn't find a clear section level; falling back to semantic <section> tags.`
      );
    } else {
      // Step 3: heading-anchored fallback
      const headingSections = findHeadingFallbackSections(contentRoot);
      if (headingSections.length > 0) {
        detectedSections = headingSections;
        method = "heading-fallback";
        result.warnings.push(
          `Structural detection didn't find a clear section level; falling back to heading-anchored chunking. ` +
          `Some sections may be broken at heading boundaries that don't match real section breaks.`
        );
      } else {
        result.warnings.push(
          "Couldn't detect any sections. The page may have an unusual structure."
        );
        return result;
      }
    }
  }

  result.detectionMethod = method;

  let order = 0;
  for (const candidate of detectedSections) {
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
      detectionMethod: method as DetectedSection["detectionMethod"],
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