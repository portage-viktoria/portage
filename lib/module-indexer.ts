/**
 * Module indexer — v3 (Phase 1).
 *
 * Captures everything the publisher and matcher need to work generically
 * across any HubSpot theme:
 *
 *   1. Full field tree with names, types, labels, defaults, and nesting
 *   2. Group/repeater structure so params can mirror it correctly
 *   3. Module defaults — all default values, ready to merge with our params
 *   4. Type signature for structural matching (counts of normalized types)
 *   5. content_types filter — only modules valid for SITE_PAGE are kept
 *
 * Backwards compatible with v2:
 *   - `fields` aggregate summary kept for any UI that relied on it
 *   - `fieldDetails` kept (with same shape) so the v3 matcher still works
 *   - New: `fieldSchema` (full tree), `defaults` (merged values), `signature`
 */

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const MAX_CONCURRENCY = 5;

// ============================================================
// Normalized field categories
// Maps HubSpot's 30+ field types into a smaller set we can reason about
// ============================================================

export type FieldCategory =
  | "text"           // text, plain string content
  | "richtext"       // richtext (HTML body)
  | "image"          // image
  | "background"     // backgroundimage (style field)
  | "link"           // link, url, cta
  | "choice"         // choice, boolean
  | "color"          // color, gradient
  | "number"         // number
  | "icon"           // icon
  | "embed"          // embed, video
  | "form"           // form
  | "menu"           // menu, simplemenu
  | "spacing"        // spacing, border, alignment, font
  | "data"           // hubdbtable, hubdbrow, blog, page, crmobject, crmobjectproperty, tag, file, date, datetime, email
  | "repeater"       // group with occurrence > 1
  | "group"          // group with occurrence == 1 (just nesting)
  | "other";

const TYPE_TO_CATEGORY: Record<string, FieldCategory> = {
  text: "text",
  richtext: "richtext",
  image: "image",
  backgroundimage: "background",
  link: "link",
  url: "link",
  cta: "link",
  choice: "choice",
  boolean: "choice",
  color: "color",
  gradient: "color",
  number: "number",
  icon: "icon",
  embed: "embed",
  video: "embed",
  form: "form",
  menu: "menu",
  simplemenu: "menu",
  spacing: "spacing",
  border: "spacing",
  alignment: "spacing",
  textalignment: "spacing",
  font: "spacing",
  hubdbtable: "data",
  hubdbrow: "data",
  blog: "data",
  page: "data",
  crmobject: "data",
  crmobjectproperty: "data",
  tag: "data",
  file: "data",
  date: "data",
  datetime: "data",
  email: "data",
  followupemail: "data",
  logo: "image",
};

function categorize(type: string): FieldCategory {
  return TYPE_TO_CATEGORY[type.toLowerCase()] ?? "other";
}

// ============================================================
// Public types
// ============================================================

export type FieldNode = {
  name: string;
  label: string;
  type: string;
  category: FieldCategory;
  required: boolean;
  default: unknown;
  // For groups (and repeaters): the children, in order
  children?: FieldNode[];
  // True if this is a group with occurrence allowing > 1 entry
  isRepeater: boolean;
  // For repeaters: the default value of one item (children's defaults)
  itemDefault?: Record<string, unknown>;
};

// Aggregate summary kept for backwards compat
export type FieldSummary = {
  type: string;
  category: FieldCategory;
  count: number;
};

// Per-field detail kept for backwards compat (used by current matcher)
export type FieldDetail = {
  name: string;
  label: string;
  type: string;
  category: FieldCategory;
  isRepeater: boolean;
  childFields?: Array<{ name: string; type: string; category: FieldCategory }>;
};

// Type signature — used for structural matching in Phase 3
export type TypeSignature = {
  text: number;
  richtext: number;
  image: number;
  link: number;
  repeaterCount: number;
  repeaterMaxChildren: number;
  totalContentFields: number; // text + richtext + image + link + repeater
  // includes ALL field types so we can see total complexity
  totalFields: number;
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
  path: string;                  // path WITH .module suffix as on disk
  apiPath: string;               // path WITHOUT .module — used in HubSpot params
  fields: FieldSummary[];        // backwards-compat aggregate
  fieldDetails: FieldDetail[];   // backwards-compat per-field summary
  fieldSchema: FieldNode[];      // NEW: full tree with defaults
  defaults: Record<string, unknown>; // NEW: full default params for the module
  signature: TypeSignature;      // NEW: for structural matching
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

async function fetchTextFile(accessToken: string, path: string): Promise<string | null> {
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
// fields.json parsing — extracts the full tree
// ============================================================

type RawFieldNode = {
  name?: string;
  type?: string;
  label?: string;
  required?: boolean;
  default?: unknown;
  occurrence?: { min?: number; max?: number } | null;
  children?: RawFieldNode[];
};

function parseFieldNode(raw: RawFieldNode): FieldNode | null {
  if (!raw || typeof raw !== "object") return null;
  const name = typeof raw.name === "string" ? raw.name : "";
  const type = typeof raw.type === "string" ? raw.type : "";
  if (!name || !type) return null;

  const label = typeof raw.label === "string" ? raw.label : name;
  const required = raw.required === true;
  const category = categorize(type);

  // Group handling — recurse
  if (type === "group") {
    const occ = raw.occurrence;
    const isRepeater =
      !!occ && (occ.max === undefined || (typeof occ.max === "number" && occ.max > 1));

    const children: FieldNode[] = [];
    if (Array.isArray(raw.children)) {
      for (const c of raw.children) {
        const parsed = parseFieldNode(c);
        if (parsed) children.push(parsed);
      }
    }

    // For repeaters: build a single-item default from children's defaults
    let itemDefault: Record<string, unknown> | undefined;
    if (isRepeater) {
      itemDefault = {};
      for (const child of children) {
        itemDefault[child.name] = child.default;
      }
    }

    // Default for the group itself
    let groupDefault: unknown;
    if (isRepeater) {
      // Repeater default is array of items if specified
      groupDefault = Array.isArray(raw.default) ? raw.default : [];
    } else {
      // Non-repeating group: nested object of children's defaults
      const obj: Record<string, unknown> = {};
      for (const child of children) {
        obj[child.name] = child.default;
      }
      groupDefault = obj;
    }

    return {
      name,
      label,
      type,
      category: isRepeater ? "repeater" : "group",
      required,
      default: groupDefault,
      children,
      isRepeater,
      itemDefault,
    };
  }

  return {
    name,
    label,
    type,
    category,
    required,
    default: raw.default,
    isRepeater: false,
  };
}

function parseFieldsJson(rawJson: unknown): FieldNode[] {
  if (!Array.isArray(rawJson)) return [];
  const result: FieldNode[] = [];
  for (const node of rawJson as RawFieldNode[]) {
    const parsed = parseFieldNode(node);
    if (parsed) result.push(parsed);
  }
  return result;
}

// ============================================================
// Derive defaults, signature, and back-compat structures from the schema
// ============================================================

/**
 * Build a flat defaults object: { fieldName: defaultValue, ... }
 * For nested groups, the default is a nested object.
 * For repeaters, the default is an array (usually empty).
 */
function buildDefaults(schema: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of schema) {
    out[node.name] = node.default;
  }
  return out;
}

/**
 * Compute a type signature by walking the schema.
 * Top-level fields contribute to the count. Repeaters contribute their
 * child counts to repeaterMaxChildren so we can identify "card grid"-style
 * modules where the action is in the repeater.
 */
function buildSignature(schema: FieldNode[]): TypeSignature {
  const sig: TypeSignature = {
    text: 0,
    richtext: 0,
    image: 0,
    link: 0,
    repeaterCount: 0,
    repeaterMaxChildren: 0,
    totalContentFields: 0,
    totalFields: 0,
  };

  function add(category: FieldCategory) {
    sig.totalFields += 1;
    if (category === "text") sig.text += 1;
    else if (category === "richtext") sig.richtext += 1;
    else if (category === "image") sig.image += 1;
    else if (category === "link") sig.link += 1;
    else if (category === "repeater") sig.repeaterCount += 1;
  }

  for (const node of schema) {
    add(node.category);
    if (node.isRepeater && Array.isArray(node.children)) {
      sig.repeaterMaxChildren = Math.max(sig.repeaterMaxChildren, node.children.length);
    }
  }

  sig.totalContentFields =
    sig.text + sig.richtext + sig.image + sig.link + sig.repeaterCount;

  return sig;
}

/**
 * Backwards-compat: aggregate field summary by category.
 */
function buildSummary(schema: FieldNode[]): FieldSummary[] {
  const counts = new Map<FieldCategory, { count: number; rawTypes: Set<string> }>();
  function walk(nodes: FieldNode[]) {
    for (const n of nodes) {
      if (n.category === "group") {
        if (Array.isArray(n.children)) walk(n.children);
        continue;
      }
      const existing = counts.get(n.category) ?? { count: 0, rawTypes: new Set() };
      existing.count += 1;
      existing.rawTypes.add(n.type);
      counts.set(n.category, existing);
    }
  }
  walk(schema);

  const out: FieldSummary[] = Array.from(counts.entries()).map(([cat, info]) => ({
    type: Array.from(info.rawTypes).join(", "),
    category: cat,
    count: info.count,
  }));
  out.sort((a, b) => b.count - a.count);
  return out;
}

/**
 * Backwards-compat: flat per-field detail array.
 */
function buildFieldDetails(schema: FieldNode[]): FieldDetail[] {
  const out: FieldDetail[] = [];
  for (const n of schema) {
    if (n.category === "group" && Array.isArray(n.children)) {
      // Non-repeating group: emit children
      for (const c of n.children) {
        out.push({
          name: `${n.name}.${c.name}`,
          label: c.label,
          type: c.type,
          category: c.category,
          isRepeater: false,
        });
      }
      continue;
    }
    out.push({
      name: n.name,
      label: n.label,
      type: n.type,
      category: n.category,
      isRepeater: n.isRepeater,
      childFields: n.isRepeater && Array.isArray(n.children)
        ? n.children.map((c) => ({ name: c.name, type: c.type, category: c.category }))
        : undefined,
    });
  }
  return out;
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

function classifyStructure(name: string, label: string, metaTags: string[]): StructuralTag[] {
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

function stripModuleSuffix(p: string): string {
  return p.replace(/\.module$/i, "");
}

async function indexModule(
  accessToken: string,
  themePath: string,
  moduleName: string
): Promise<ModuleEntry | null> {
  const modulePath = `${themePath}/modules/${moduleName}`;
  const warnings: string[] = [];

  const fieldsJson = await fetchJsonFile<unknown>(accessToken, `${modulePath}/fields.json`);
  let schema: FieldNode[] = [];
  if (fieldsJson === null) {
    warnings.push("fields.json missing or unreadable");
  } else {
    schema = parseFieldsJson(fieldsJson);
  }

  const metaJson = await fetchJsonFile<MetaJson>(accessToken, `${modulePath}/meta.json`);

  const label =
    metaJson && typeof metaJson.label === "string" && metaJson.label.trim().length > 0
      ? metaJson.label.trim()
      : moduleName.replace(/\.module$/i, "").replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

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

  // Filter: only modules valid for SITE_PAGE (or where content_types is unspecified
  // — many themes leave it open which means "any type")
  if (contentTypes && contentTypes.length > 0 && !contentTypes.includes("SITE_PAGE")) {
    return null;
  }

  // Skip modules that aren't available for new content
  if (metaJson?.is_available_for_new_content === false) {
    return null;
  }

  const tags = classifyStructure(moduleName, label, metaTags);
  const defaults = buildDefaults(schema);
  const signature = buildSignature(schema);
  const summary = buildSummary(schema);
  const fieldDetails = buildFieldDetails(schema);
  const hasRepeater = schema.some((n) => n.isRepeater);

  return {
    name: moduleName,
    label,
    description,
    path: modulePath,                              // with .module suffix
    apiPath: stripModuleSuffix(modulePath),        // without .module suffix — for HubSpot API
    fields: summary,
    fieldDetails,
    fieldSchema: schema,
    defaults,
    signature,
    hasRepeater,
    totalFields: signature.totalFields,
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

  const indexed = await parallelLimit(moduleNames, MAX_CONCURRENCY, (name) =>
    indexModule(accessToken, themePath, name)
  );

  // Filter out modules that returned null (filtered by content_types)
  const modules = indexed.filter((m): m is ModuleEntry => m !== null);
  modules.sort((a, b) => a.label.localeCompare(b.label));

  if (indexed.length > modules.length) {
    result.warnings.push(
      `${indexed.length - modules.length} modules were filtered out (not available for SITE_PAGE).`
    );
  }

  result.modules = modules;
  result.moduleCount = modules.length;

  return result;
}