/**
 * Module indexer — v2.
 *
 * Captures the actual field NAMES from each module's fields.json, not just
 * categorized counts. This is critical because the matcher needs to produce
 * params keyed by the module's exact field names (e.g. "title", "text",
 * "image"), not generic names like "headline" or "body".
 *
 * Backwards-compatible: keeps the old `fields` summary array for the UI,
 * adds a new `fieldDetails` array with full information for the matcher.
 */

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const MAX_CONCURRENCY = 5;

// ============================================================
// Types
// ============================================================

export type FieldSummary = {
  type: string;
  category: FieldCategory;
  count: number;
};

export type FieldCategory =
  | "text"
  | "image"
  | "link"
  | "choice"
  | "color"
  | "number"
  | "icon"
  | "embed"
  | "repeater"
  | "group"
  | "other";

/**
 * Per-field detail used by the matcher. Captures enough information that
 * Claude can pick the right field for each piece of source content.
 */
export type FieldDetail = {
  name: string;          // exact field key from fields.json
  label: string;         // human label
  type: string;          // raw HubSpot field type
  category: FieldCategory;
  isRepeater: boolean;
  // For repeaters, the children's field names so Claude understands the shape
  childFields?: Array<{ name: string; type: string; category: FieldCategory }>;
};

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
  name: string;
  label: string;
  description?: string;
  path: string;
  // Existing aggregate summary (kept for UI compatibility)
  fields: FieldSummary[];
  // NEW: detailed per-field info for the matcher
  fieldDetails: FieldDetail[];
  hasRepeater: boolean;
  totalFields: number;
  tags: StructuralTag[];
  metaTags?: string[];
  isGlobal?: boolean;
  contentTypes?: string[];
  warnings: string[];
};

export type IndexResult = {
  themePath: string;
  modules: ModuleEntry[];
  moduleCount: number;
  warnings: string[];
  scannedAt: string;
};

// ============================================================
// Concurrency
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
    const cleaned = text.replace(/^\uFEFF/, "");
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

// ============================================================
// Field analysis
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
 * Walk fields.json. Produces both:
 *   - `fields`: aggregated summary by category (existing UI uses this)
 *   - `fieldDetails`: per-field info with exact names (for the matcher)
 */
function analyzeFields(fieldsJson: unknown): {
  fields: FieldSummary[];
  fieldDetails: FieldDetail[];
  hasRepeater: boolean;
  totalFields: number;
} {
  const counts = new Map<FieldCategory, { count: number; rawTypes: Set<string> }>();
  const details: FieldDetail[] = [];
  let hasRepeater = false;
  let totalFields = 0;

  function walk(nodes: FieldsJsonNode[]) {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const type = typeof node.type === "string" ? node.type : "";
      const name = typeof node.name === "string" ? node.name : "";
      const label = typeof node.label === "string" ? node.label : name;

      if (type === "group") {
        const occ = node.occurrence;
        const isRepeater =
          !!occ &&
          (occ.max === undefined ||
            (typeof occ.max === "number" && occ.max > 1));

        if (isRepeater) {
          hasRepeater = true;
          // Aggregate
          const existing = counts.get("repeater") ?? { count: 0, rawTypes: new Set() };
          existing.count += 1;
          existing.rawTypes.add("group");
          counts.set("repeater", existing);
          totalFields += 1;

          // Detail entry capturing children's names
          const childFields =
            Array.isArray(node.children)
              ? node.children
                  .filter((c) => c && typeof c.name === "string" && typeof c.type === "string")
                  .map((c) => ({
                    name: c.name as string,
                    type: c.type as string,
                    category: categorizeField(c.type as string),
                  }))
              : undefined;

          if (name) {
            details.push({
              name,
              label,
              type: "group",
              category: "repeater",
              isRepeater: true,
              childFields,
            });
          }
          continue;
        }

        // Non-repeating group — recurse
        if (Array.isArray(node.children)) walk(node.children);
        continue;
      }

      if (!type) continue;
      const category = categorizeField(type);

      // Aggregate
      const existing = counts.get(category) ?? { count: 0, rawTypes: new Set() };
      existing.count += 1;
      existing.rawTypes.add(type);
      counts.set(category, existing);
      totalFields += 1;

      // Detail entry
      if (name) {
        details.push({
          name,
          label,
          type,
          category,
          isRepeater: false,
        });
      }
    }
  }

  if (Array.isArray(fieldsJson)) walk(fieldsJson as FieldsJsonNode[]);

  const fields: FieldSummary[] = Array.from(counts.entries()).map(
    ([category, info]) => ({
      type: Array.from(info.rawTypes).join(", "),
      category,
      count: info.count,
    })
  );
  fields.sort((a, b) => b.count - a.count);

  return { fields, fieldDetails: details, hasRepeater, totalFields };
}

// ============================================================
// Structural classification
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

  const fieldsJson = await fetchJsonFile<unknown>(accessToken, `${modulePath}/fields.json`);
  let analysis;
  if (fieldsJson === null) {
    warnings.push("fields.json missing or unreadable");
    analysis = { fields: [], fieldDetails: [], hasRepeater: false, totalFields: 0 };
  } else {
    analysis = analyzeFields(fieldsJson);
  }

  const metaJson = await fetchJsonFile<MetaJson>(accessToken, `${modulePath}/meta.json`);
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

  const tags = classifyStructure(moduleName, label, metaTags);

  return {
    name: moduleName,
    label,
    description,
    path: modulePath,
    fields: analysis.fields,
    fieldDetails: analysis.fieldDetails,
    hasRepeater: analysis.hasRepeater,
    totalFields: analysis.totalFields,
    tags,
    metaTags: metaTags.length > 0 ? metaTags : undefined,
    isGlobal,
    contentTypes,
    warnings,
  };
}

// ============================================================
// Top-level
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

  const modulesFolder = await fetchFolderMetadata(accessToken, `${themePath}/modules`);

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

  const moduleNames = modulesFolder.children.filter((child) => {
    if (typeof child !== "string") return false;
    if (child.startsWith(".") || child.startsWith("_")) return false;
    return true;
  });

  if (moduleNames.length === 0) {
    result.warnings.push("No module folders found under /modules.");
    return result;
  }

  const modules = await parallelLimit(moduleNames, MAX_CONCURRENCY, (name) =>
    indexModule(accessToken, themePath, name)
  );

  modules.sort((a, b) => a.label.localeCompare(b.label));

  result.modules = modules;
  result.moduleCount = modules.length;

  return result;
}