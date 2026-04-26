/**
 * Module indexer.
 *
 * Given a HubSpot access token and a theme path, walks the theme's `modules/`
 * folder and produces a structured catalog. Each module entry summarizes:
 *   - identity (path, name, label)
 *   - content shape (what fields it accepts, repeater info)
 *   - structural hints (grid? accordion? card row? hero?)
 *   - any author-supplied tags
 *
 * The output of this module is what gets stored in theme_indexes.modules_json
 * and what the UI browser renders. Keep it stable — schema changes here
 * require a re-index.
 *
 * Defensive throughout: HubSpot's module files are author-written, which means
 * they contain weird edge cases. We accept "missing field," "wrong type," and
 * "empty string" everywhere and degrade gracefully.
 */

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const MAX_CONCURRENCY = 5;

// ============================================================
// Types — the shape of a catalog
// ============================================================

export type FieldSummary = {
  type: string; // raw HubSpot field type
  category: FieldCategory; // our normalized bucket
  count: number; // how many fields of this type appear in the module
};

export type FieldCategory =
  | "text" // text, richtext
  | "image" // image
  | "link" // link, url, cta
  | "choice" // choice, boolean
  | "color"
  | "number"
  | "icon"
  | "embed" // video, embed
  | "repeater" // group with occurrence (i.e. a list of repeating items)
  | "group" // non-repeating field group
  | "other";

export type StructuralTag =
  | "hero"
  | "accordion"
  | "tabs"
  | "card-grid"
  | "feature-list"
  | "cta-banner"
  | "testimonial"
  | "logo-strip"
  | "stats"
  | "gallery"
  | "form"
  | "rich-text"
  | "menu"
  | "blog-listing"
  | "unknown";

export type ModuleEntry = {
  name: string; // folder name, e.g. "accordion"
  label: string; // human-readable from meta.json, fallback to name
  description?: string;
  path: string; // full path within the theme, e.g. "Focus-child/modules/accordion"
  // Field summary
  fields: FieldSummary[];
  hasRepeater: boolean;
  totalFields: number;
  // Structural classification
  tags: StructuralTag[];
  // Author signals from meta.json
  metaTags?: string[]; // tags as written by the author
  isGlobal?: boolean;
  contentTypes?: string[]; // page types module is allowed on
  // Diagnostic info — sometimes a module fails to fully parse and we want to
  // surface that in the UI rather than silently dropping it
  warnings: string[];
};

export type IndexResult = {
  themePath: string;
  modules: ModuleEntry[];
  // Catalog-level diagnostics
  moduleCount: number;
  warnings: string[]; // issues encountered at the catalog level (e.g. /modules folder missing)
  scannedAt: string; // ISO timestamp
};

// ============================================================
// Concurrency limiter (same pattern as elsewhere)
// ============================================================

async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await task(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ============================================================
// HubSpot fetchers
// ============================================================

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

type FolderMetadata = {
  folder?: boolean;
  path?: string;
  name?: string;
  children?: string[];
};

async function fetchFolderMetadata(
  accessToken: string,
  path: string
): Promise<FolderMetadata | null> {
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/metadata/${encodePath(path)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchTextFile(
  accessToken: string,
  path: string
): Promise<string | null> {
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/content/${encodePath(path)}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/octet-stream",
    },
  });
  if (!res.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJsonFile<T = unknown>(
  accessToken: string,
  path: string
): Promise<T | null> {
  const text = await fetchTextFile(accessToken, path);
  if (text === null) return null;
  try {
    // Strip BOM if present (some HubSpot files have it)
    const cleaned = text.replace(/^\uFEFF/, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// ============================================================
// Field analysis — turn a module's fields.json into a summary
// ============================================================

type FieldsJsonNode = {
  name?: string;
  type?: string;
  label?: string;
  occurrence?: { min?: number; max?: number } | null;
  children?: FieldsJsonNode[];
};

function categorizeField(type: string): FieldCategory {
  const t = type.toLowerCase();
  if (t === "text" || t === "richtext") return "text";
  if (t === "image") return "image";
  if (t === "link" || t === "url" || t === "cta") return "link";
  if (t === "choice" || t === "boolean") return "choice";
  if (t === "color") return "color";
  if (t === "number") return "number";
  if (t === "icon") return "icon";
  if (t === "video" || t === "embed") return "embed";
  return "other";
}

/**
 * Walk a fields.json tree and produce a summary of field types/counts.
 * Repeating groups (groups with occurrence.max > 1) are collapsed into a
 * single "repeater" entry — we don't recurse into their children for the
 * top-level summary because a repeater's shape is its child template.
 */
function summarizeFields(fieldsJson: unknown): {
  fields: FieldSummary[];
  hasRepeater: boolean;
  totalFields: number;
} {
  const counts = new Map<FieldCategory, { count: number; rawTypes: Set<string> }>();
  let hasRepeater = false;
  let totalFields = 0;

  function walk(nodes: FieldsJsonNode[]) {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = typeof node.type === "string" ? node.type : "";

      // A group with occurrence.max > 1 (or unbounded) is a repeater
      if (type === "group") {
        const occ = node.occurrence;
        const isRepeater = !!occ && (occ.max === undefined || (typeof occ.max === "number" && occ.max > 1));
        if (isRepeater) {
          hasRepeater = true;
          const existing = counts.get("repeater") ?? { count: 0, rawTypes: new Set() };
          existing.count += 1;
          existing.rawTypes.add("group");
          counts.set("repeater", existing);
          totalFields += 1;
          // Don't recurse into a repeater's children at this level — its
          // shape is its child template, surfaced separately if needed
          continue;
        }
        // Non-repeating group — recurse to count its children
        if (Array.isArray(node.children)) {
          walk(node.children);
        }
        continue;
      }

      if (!type) continue;
      const category = categorizeField(type);
      const existing = counts.get(category) ?? { count: 0, rawTypes: new Set() };
      existing.count += 1;
      existing.rawTypes.add(type);
      counts.set(category, existing);
      totalFields += 1;
    }
  }

  if (Array.isArray(fieldsJson)) {
    walk(fieldsJson as FieldsJsonNode[]);
  }

  const fields: FieldSummary[] = Array.from(counts.entries()).map(
    ([category, info]) => ({
      type: Array.from(info.rawTypes).join(", "),
      category,
      count: info.count,
    })
  );

  fields.sort((a, b) => b.count - a.count);

  return { fields, hasRepeater, totalFields };
}

// ============================================================
// Structural classification — turn name + label + meta tags + fields
// into a small set of structural hints
// ============================================================

const NAME_PATTERNS: Array<[RegExp, StructuralTag]> = [
  [/(^|-)hero(-|$)|hero[-_]?(slider|banner)/i, "hero"],
  [/accordion|faq/i, "accordion"],
  [/^tabs$|^tab[-_]/i, "tabs"],
  [/card[s]?$|card[-_]grid|grid[-_]card/i, "card-grid"],
  [/feature[s]?[-_]?list|features$|pillar/i, "feature-list"],
  [/cta[-_]?(banner|section|band)|call[-_]?to[-_]?action/i, "cta-banner"],
  [/testimonial|quote/i, "testimonial"],
  [/(^|-)logo[s]?(-|$)|client[s]?$|brand[s]?$/i, "logo-strip"],
  [/stats?$|number[-_]counter|counter[s]?$|metric/i, "stats"],
  [/gallery|portfolio|media[-_]boxes/i, "gallery"],
  [/form/i, "form"],
  [/rich[-_]?text|wysiwyg/i, "rich-text"],
  [/^menu$|navigation|nav$/i, "menu"],
  [/blog[-_]?listing|blog[-_]?posts/i, "blog-listing"],
];

function classifyStructure(
  name: string,
  label: string,
  metaTags: string[]
): StructuralTag[] {
  const tags = new Set<StructuralTag>();
  const haystack = `${name} ${label} ${metaTags.join(" ")}`.toLowerCase();

  for (const [pattern, tag] of NAME_PATTERNS) {
    if (pattern.test(haystack)) tags.add(tag);
  }

  if (tags.size === 0) tags.add("unknown");
  return Array.from(tags);
}

// ============================================================
// Single-module indexer
// ============================================================

type MetaJson = {
  label?: string;
  description?: string;
  tags?: unknown;
  global?: boolean;
  is_available_for_new_content?: boolean;
  content_types?: unknown;
  smart_type?: string;
};

async function indexModule(
  accessToken: string,
  themePath: string,
  moduleName: string
): Promise<ModuleEntry> {
  const modulePath = `${themePath}/modules/${moduleName}`;
  const warnings: string[] = [];

  // fields.json — the content shape
  const fieldsJson = await fetchJsonFile<unknown>(
    accessToken,
    `${modulePath}/fields.json`
  );
  let fieldSummary: ReturnType<typeof summarizeFields>;
  if (fieldsJson === null) {
    warnings.push("fields.json missing or unreadable");
    fieldSummary = { fields: [], hasRepeater: false, totalFields: 0 };
  } else {
    fieldSummary = summarizeFields(fieldsJson);
  }

  // meta.json — labels, tags, content type hints
  const metaJson = await fetchJsonFile<MetaJson>(
    accessToken,
    `${modulePath}/meta.json`
  );
  const label =
    metaJson && typeof metaJson.label === "string" && metaJson.label.trim().length > 0
      ? metaJson.label.trim()
      : moduleName.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  const description =
    metaJson && typeof metaJson.description === "string" && metaJson.description.trim().length > 0
      ? metaJson.description.trim()
      : undefined;

  const metaTags = Array.isArray(metaJson?.tags)
    ? (metaJson?.tags as unknown[]).filter((t): t is string => typeof t === "string")
    : [];

  const isGlobal = typeof metaJson?.global === "boolean" ? metaJson.global : undefined;

  const contentTypes = Array.isArray(metaJson?.content_types)
    ? (metaJson?.content_types as unknown[]).filter((t): t is string => typeof t === "string")
    : undefined;

  // Structural classification
  const tags = classifyStructure(moduleName, label, metaTags);

  return {
    name: moduleName,
    label,
    description,
    path: modulePath,
    fields: fieldSummary.fields,
    hasRepeater: fieldSummary.hasRepeater,
    totalFields: fieldSummary.totalFields,
    tags,
    metaTags: metaTags.length > 0 ? metaTags : undefined,
    isGlobal,
    contentTypes,
    warnings,
  };
}

// ============================================================
// Top-level: index a whole theme
// ============================================================

export async function indexTheme(
  accessToken: string,
  themePath: string
): Promise<IndexResult> {
  const result: IndexResult = {
    themePath,
    modules: [],
    moduleCount: 0,
    warnings: [],
    scannedAt: new Date().toISOString(),
  };

  // Step 1: list the contents of <theme>/modules
  const modulesFolder = await fetchFolderMetadata(
    accessToken,
    `${themePath}/modules`
  );

  if (!modulesFolder) {
    result.warnings.push(
      `Couldn't read ${themePath}/modules. The theme may not have a modules folder, or its files aren't accessible.`
    );
    return result;
  }

  if (!Array.isArray(modulesFolder.children) || modulesFolder.children.length === 0) {
    result.warnings.push(`${themePath}/modules is empty.`);
    return result;
  }

  // Each child of /modules that ends in `.module` is a module folder.
  // HubSpot modules use the `.module` suffix for their folder names — though
  // we accept any folder as a fallback to handle non-standard themes.
  const moduleNames = modulesFolder.children.filter((child) => {
    if (typeof child !== "string") return false;
    if (child.startsWith(".") || child.startsWith("_")) return false;
    return true;
  });

  if (moduleNames.length === 0) {
    result.warnings.push("No module folders found under /modules.");
    return result;
  }

  // Step 2: index each module in parallel (with concurrency cap)
  const modules = await parallelLimit(moduleNames, MAX_CONCURRENCY, (name) =>
    indexModule(accessToken, themePath, name)
  );

  // Sort by label for stable display
  modules.sort((a, b) => a.label.localeCompare(b.label));

  result.modules = modules;
  result.moduleCount = modules.length;

  return result;
}