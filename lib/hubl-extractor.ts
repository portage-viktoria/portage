/**
 * HubL render summary extractor.
 *
 * Walks a module.html template and produces a per-field summary of where
 * each field renders — which HTML tag wraps it, what CSS classes are on
 * that tag, and whether it's inside a {% for %} loop over a repeater.
 *
 * This is intentionally NOT a full HubL parser. It uses regex against
 * the most common patterns. It catches >90% of meaningful render contexts
 * in real-world themes.
 *
 * Output shape (per field name):
 *
 *   {
 *     "title": [
 *       { tag: "h1", classes: ["hero-headline"], inRepeater: false }
 *     ],
 *     "subtitle": [
 *       { tag: "p", classes: ["eyebrow"], inRepeater: false }
 *     ],
 *     "items": [
 *       // Repeater itself doesn't appear here directly — its children do
 *     ],
 *     "items.title": [
 *       { tag: "h3", classes: [], inRepeater: true, repeaterField: "items" }
 *     ]
 *   }
 */

export type FieldRenderContext = {
  tag: string;
  classes: string[];
  inRepeater: boolean;
  repeaterField?: string;
  /**
   * "text" if the field is rendered as text content (between tags),
   * "attribute" if it's used as an attribute value (e.g. src=, href=),
   * "conditional" if the field appears only inside {% if %} as a check
   */
  context: "text" | "attribute" | "conditional";
  /** The attribute name if context == "attribute" */
  attribute?: string;
};

export type RenderSummary = Record<string, FieldRenderContext[]>;

// ============================================================
// HubL preprocessing
// ============================================================

/**
 * Strip HubL/Jinja comments and CSS/JS blocks before pattern matching.
 */
function stripNoise(hubl: string): string {
  // Remove {# comments #}
  let out = hubl.replace(/\{#[\s\S]*?#\}/g, "");
  // Remove <style>...</style>
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Remove <script>...</script>
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  return out;
}

// ============================================================
// Locate all {% for %} loops over repeater fields
// Returns ranges in the source string that are inside a repeater context
// ============================================================

type RepeaterRange = {
  start: number;       // index of {% for %} start tag
  end: number;         // index after {% endfor %}
  repeaterField: string;
};

function findRepeaterRanges(hubl: string): RepeaterRange[] {
  const ranges: RepeaterRange[] = [];
  // Match {% for X in module.FIELD %} ... {% endfor %}
  // We capture the field name being iterated.
  const forRegex = /\{%\s*for\s+\w+\s+in\s+module\.(\w+)\s*%\}/gi;
  let match: RegExpExecArray | null;

  while ((match = forRegex.exec(hubl)) !== null) {
    const field = match[1];
    const startIdx = match.index;
    // Find the matching {% endfor %} (allow nesting)
    let depth = 1;
    const tail = hubl.slice(forRegex.lastIndex);
    const tagRegex = /\{%\s*(for|endfor)[\s\S]*?%\}/gi;
    let inner: RegExpExecArray | null;
    while ((inner = tagRegex.exec(tail)) !== null) {
      const isFor = /\{%\s*for/i.test(inner[0]);
      depth += isFor ? 1 : -1;
      if (depth === 0) {
        ranges.push({
          start: startIdx,
          end: forRegex.lastIndex + inner.index + inner[0].length,
          repeaterField: field,
        });
        break;
      }
    }
  }

  return ranges;
}

function findRepeaterAtIndex(
  ranges: RepeaterRange[],
  index: number
): RepeaterRange | null {
  for (const r of ranges) {
    if (index >= r.start && index < r.end) return r;
  }
  return null;
}

// ============================================================
// Find the wrapping HTML tag for a given index
// ============================================================

/**
 * Walk backwards from `index` to find the most recent open tag.
 * Returns { tag, classes } if found, null otherwise.
 *
 * This is heuristic — it assumes the field appears as text content
 * inside the most recently opened tag, which is true >90% of the time.
 */
function findWrappingTag(
  source: string,
  index: number
): { tag: string; classes: string[] } | null {
  // Look back up to 200 chars for an open tag
  const lookback = source.slice(Math.max(0, index - 400), index);
  const tagMatches = [...lookback.matchAll(/<(\w+)([^>]*)>/g)];
  if (tagMatches.length === 0) return null;

  // The most recent unclosed tag — but for simplicity, take the last one
  const last = tagMatches[tagMatches.length - 1];
  const tag = last[1].toLowerCase();
  const attrs = last[2];

  // Skip self-closing or void tags (we don't want img wrapping a text field)
  const voidTags = new Set([
    "img", "br", "hr", "input", "meta", "link", "source", "track", "wbr",
  ]);
  if (voidTags.has(tag)) {
    // For void tags, this is an "attribute" context — return them as such
    // but only if the field appears in the tag's attributes (handled separately)
    return null;
  }

  // Extract class= attribute
  const classMatch = attrs.match(/class\s*=\s*"([^"]*)"/);
  const classes = classMatch
    ? classMatch[1].split(/\s+/).filter((c) => c && !c.includes("{{"))
    : [];

  return { tag, classes };
}

// ============================================================
// Detect attribute usage
// ============================================================

/**
 * Detect if a {{ module.field }} appears INSIDE a tag as an attribute value.
 * E.g. <img src="{{ module.image.src }}"> or <a href="{{ module.cta.url }}">.
 */
function detectAttributeUsage(
  source: string,
  matchIndex: number
): { tag: string; attribute: string } | null {
  // Look back for the start of the current tag (<...
  const lookback = source.slice(Math.max(0, matchIndex - 300), matchIndex);
  const lastOpen = lookback.lastIndexOf("<");
  const lastClose = lookback.lastIndexOf(">");

  // We're inside a tag if there's a < after the last >
  if (lastOpen === -1 || lastOpen <= lastClose) return null;

  const insideTag = lookback.slice(lastOpen);
  // First word is the tag name
  const tagNameMatch = insideTag.match(/^<(\w+)/);
  if (!tagNameMatch) return null;
  const tag = tagNameMatch[1].toLowerCase();

  // Find the most recent attribute name before this position
  // Pattern: word="...   we want the word
  const attrMatch = insideTag.match(/(\w[\w-]*)\s*=\s*["'][^"']*$/);
  if (!attrMatch) return null;

  return { tag, attribute: attrMatch[1].toLowerCase() };
}

// ============================================================
// Main extraction
// ============================================================

/**
 * Extract the render summary for a module from its module.html.
 *
 * Looks for occurrences of:
 *   {{ module.fieldname }}
 *   {{ module.fieldname.subfield }}
 *   {{ module.fieldname|filter }}
 *   {{ field }}                (when inside a for loop)
 *   {{ field.subfield }}       (when inside a for loop)
 *
 * For each, determines whether it's text content or an attribute, what
 * tag/classes wrap it, and whether it's inside a repeater loop.
 */
export function extractRenderSummary(hubl: string): RenderSummary {
  if (!hubl || typeof hubl !== "string") return {};

  const cleaned = stripNoise(hubl);
  const repeaterRanges = findRepeaterRanges(cleaned);

  // Build a map of repeater iterator names → repeater field name
  // E.g. {% for card in module.cards %} means inside this range, "card.X" refers to "cards.X"
  const iteratorMap = new Map<string, string>();
  const forRegex = /\{%\s*for\s+(\w+)\s+in\s+module\.(\w+)\s*%\}/gi;
  let m: RegExpExecArray | null;
  while ((m = forRegex.exec(cleaned)) !== null) {
    iteratorMap.set(m[1], m[2]);
  }

  const summary: RenderSummary = {};

  // Match {{ module.field }} or {{ module.field.subfield }} — possibly with filters
  // Also match {{ iter.field }} when iter is a known repeater iterator
  const exprRegex = /\{\{\s*([\w.]+)(?:\s*\|[^}]*)?\s*\}\}/g;

  let exprMatch: RegExpExecArray | null;
  while ((exprMatch = exprRegex.exec(cleaned)) !== null) {
    const expr = exprMatch[1];
    const matchStart = exprMatch.index;

    // Determine the field path
    let fieldKey: string | null = null;
    let inRepeater = false;
    let repeaterField: string | undefined;

    if (expr.startsWith("module.")) {
      // Top-level module field
      const path = expr.slice("module.".length);
      // For an image, drop subfields like .src, .alt — they all signal the same field
      // For a link/cta, drop .url, .href, etc.
      const baseField = path.split(".")[0];
      fieldKey = baseField;

      // Check if we're inside a repeater range
      const inRange = findRepeaterAtIndex(repeaterRanges, matchStart);
      if (inRange) {
        // module.X used inside a repeater loop — still refers to the top-level field
        inRepeater = true;
        repeaterField = inRange.repeaterField;
      }
    } else {
      // Could be `iter.subfield` from a {% for iter in module.X %}
      const dotIdx = expr.indexOf(".");
      const head = dotIdx === -1 ? expr : expr.slice(0, dotIdx);
      const tail = dotIdx === -1 ? "" : expr.slice(dotIdx + 1);
      if (iteratorMap.has(head)) {
        const repField = iteratorMap.get(head)!;
        const inRange = findRepeaterAtIndex(repeaterRanges, matchStart);
        if (inRange && inRange.repeaterField === repField) {
          // This is a repeater child field
          inRepeater = true;
          repeaterField = repField;
          const subBase = tail.split(".")[0];
          fieldKey = `${repField}.${subBase}`;
        }
      }
    }

    if (!fieldKey) continue;

    // Determine context: attribute vs text
    const attrInfo = detectAttributeUsage(cleaned, matchStart);
    let renderContext: FieldRenderContext;

    if (attrInfo) {
      renderContext = {
        tag: attrInfo.tag,
        classes: [],
        attribute: attrInfo.attribute,
        context: "attribute",
        inRepeater,
        ...(repeaterField ? { repeaterField } : {}),
      };
    } else {
      const wrap = findWrappingTag(cleaned, matchStart);
      if (wrap) {
        renderContext = {
          tag: wrap.tag,
          classes: wrap.classes,
          context: "text",
          inRepeater,
          ...(repeaterField ? { repeaterField } : {}),
        };
      } else {
        // Couldn't find a wrapping tag — record as bare
        renderContext = {
          tag: "?",
          classes: [],
          context: "text",
          inRepeater,
          ...(repeaterField ? { repeaterField } : {}),
        };
      }
    }

    if (!summary[fieldKey]) summary[fieldKey] = [];
    summary[fieldKey].push(renderContext);
  }

  return summary;
}

/**
 * Format the render summary as a compact string for inclusion in Claude prompts.
 * Designed to be human-readable and information-dense.
 *
 * Example output:
 *   title       → renders inside <h1 class="hero-headline">
 *   subtitle    → renders inside <p class="eyebrow">
 *   image       → src= attribute on <img>
 *   cards (repeater):
 *     cards.title → renders inside <h3>
 *     cards.text  → renders inside <p>
 */
export function formatRenderSummary(summary: RenderSummary): string {
  const topLevel: Record<string, FieldRenderContext[]> = {};
  const repeaterChildren: Record<string, Record<string, FieldRenderContext[]>> = {};

  for (const [field, contexts] of Object.entries(summary)) {
    if (field.includes(".")) {
      const [parent, child] = field.split(".");
      if (!repeaterChildren[parent]) repeaterChildren[parent] = {};
      repeaterChildren[parent][child] = contexts;
    } else {
      topLevel[field] = contexts;
    }
  }

  const lines: string[] = [];

  for (const [field, contexts] of Object.entries(topLevel)) {
    const desc = contexts.map(formatContext).join(", ");
    lines.push(`  ${field.padEnd(20)} → ${desc}`);
  }

  for (const [parent, children] of Object.entries(repeaterChildren)) {
    lines.push(`  ${parent} (repeater):`);
    for (const [child, contexts] of Object.entries(children)) {
      const desc = contexts.map(formatContext).join(", ");
      lines.push(`    ${parent}.${child.padEnd(16)} → ${desc}`);
    }
  }

  return lines.length > 0 ? lines.join("\n") : "  (no field renders detected)";
}

function formatContext(ctx: FieldRenderContext): string {
  if (ctx.context === "attribute") {
    return `${ctx.attribute}= attribute on <${ctx.tag}>`;
  }
  const classStr = ctx.classes.length > 0 ? ` class="${ctx.classes.join(" ")}"` : "";
  return `<${ctx.tag}${classStr}>`;
}