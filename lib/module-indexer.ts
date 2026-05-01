/**
 * Module indexer — v4 (rulebook patch).
 *
 * Adds on top of v3:
 *   - Fetches module.html for each module
 *   - Extracts a render summary using hubl-extractor
 *   - Stores both the raw template (truncated) and the summary in the catalog entry
 *
 * The render summary is what powers smarter field mapping in the matcher —
 * Claude can see "title renders as h1" and avoid putting heading text in
 * a body field.
 */

import { extractRenderSummary, formatRenderSummary, type RenderSummary } from "./hubl-extractor";

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const MAX_CONCURRENCY = 5;
// Cap raw HubL stored per module to keep theme_indexes row size reasonable.
// Render summary (which is much smaller) is the primary input to the matcher.
const MAX_HUBL_STORED_CHARS = 8000;

// ============================================================
// Normalized field categories (unchanged from v3)
// ============================================================

export type FieldCategory =
  | "text" | "richtext" | "image" | "background" | "link" | "choice"
  | "color" | "number" | "icon" | "embed" | "form" | "menu" | "spacing"
  | "data" | "repeater" | "group" | "other";

const TYPE_TO_CATEGORY: Record<string, FieldCategory> = {
  text: "text", richtext: "richtext", image: "image", backgroundimage: "background",
  link: "link", url: "link", cta: "link", choice: "choice", boolean: "choice",
  color: "color", gradient: "color", number: "number", icon: "icon",
  embed: "embed", video: "embed", form: "form", menu: "menu", simplemenu: "menu",
  spacing: "spacing", border: "spacing", alignment: "spacing", textalignment: "spacing", font: "spacing",
  hubdbtable: "data", hubdbrow: "data", blog: "data", page: "data",
  crmobject: "data", crmobjectproperty: "data", tag: "data", file: "data",
  date: "data", datetime: "data", email: "data", followupemail: "data", logo: "image",
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
  children?: FieldNode[];
  isRepeater: boolean;
  itemDefault?: Record<string, unknown>;
};

export type FieldSummary = {
  type: string;
  category: FieldCategory;
  count: number;
};

export type FieldDetail = {
  name: string;
  label: string;
  type: string;
  category: FieldCategory;
  isRepeater: boolean;
  childFields?: Array<{ name: string; type: string; category: FieldCategory }>;
};

export type TypeSignature = {
  text: number;
  richtext: number;
  image: number;
  link: number;
  repeaterCount: number;
  repeaterMaxChildren: number;
  totalContentFields: number;
  totalFields: number;
};

export type StructuralTag =
  | "hero" | "accordion" | "tabs" | "card-grid" | "feature-list"
  | "cta-banner" | "testimonial" | "logo-strip" | "stats" | "gallery"
  | "form" | "rich-text" | "menu" | "blog-listing" | "unknown";

export type ModuleEntry = {
  name: string;
  label: string;
  description?: string;
  path: string;
  apiPath: string;
  fields: FieldSummary[];
  fieldDetails: FieldDetail[];
  fieldSchema: FieldNode[];
  defaults: Record<string, unknown>;
  signature: TypeSignature;
  hasRepeater: boolean;
  totalFields: number;
  tags: StructuralTag[];
  metaTags?: string[];
  isGlobal?: boolean;
  contentTypes?: string[];
  warnings: string[];
  // NEW in v4:
  renderSummary?: RenderSummary;        // structured data
  renderSummaryText?: string;           // formatted for prompt inclusion
  hublExcerpt?: string;                 // raw HubL, truncated
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
  items: T[], limit: number, task: (item: T) => Promise<R>
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
  accessToken: string, path: string
): Promise<FolderMetadata | null> {
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/metadata/${encodePath(path)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
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
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/octet-stream" },
  });
  if (!res.ok) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchJsonFile<T = unknown>(
  accessToken: string, path: string
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
// fields.json parsing (unchanged from v3)
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

  if (type === "group") {
    const occ = raw.occurrence;
    const isRepeater = !!occ && (occ.max === undefined || (typeof occ.max === "number" && occ.max > 1));
    const children: FieldNode[] = [];
    if (Array.isArray(raw.children)) {
      for (const c of raw.children) {
        const parsed = parseFieldNode(c);
        if (parsed) children.push(parsed);
      }
    }
    let itemDefault: Record<string, unknown> | undefined;
    if (isRepeater) {
      itemDefault = {};
      for (const child of children) itemDefault[child.name] = child.default;
    }
    let groupDefault: unknown;
    if (isRepeater) {
      groupDefault = Array.isArray(raw.default) ? raw.default : [];
    } else {
      const obj: Record<string, unknown> = {};
      for (const child of children) obj[child.name] = child.default;
      groupDefault = obj;
    }
    return {
      name, label, type,
      category: isRepeater ? "repeater" : "group",
      required, default: groupDefault,
      children, isRepeater, itemDefault,
    };
  }

  return {
    name, label, type, category, required,
    default: raw.default, isRepeater: false,
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
// Derived data (unchanged from v3)
// ============================================================

function buildDefaults(schema: FieldNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of schema) out[node.name] = node.default;
  return out;
}

function buildSignature(schema: FieldNode[]): TypeSignature {
  const sig: TypeSignature = {
    text: 0, richtext: 0, image: 0, link: 0,
    repeaterCount: 0, repeaterMaxChildren: 0,
    totalContentFields: 0, totalFields: 0,
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
  sig.totalContentFields = sig.text + sig.richtext + sig.image + sig.link + sig.repeaterCount;
  return sig;
}

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

function buildFieldDetails(schema: FieldNode[]): FieldDetail[] {
  const out: FieldDetail[] = [];
  for (const n of schema) {
    if (n.category === "group" && Array.isArray(n.children)) {
      for (const c of n.children) {
        out.push({
          name: `${n.name}.${c.name}`, label: c.label, type: c.type,
          category: c.category, isRepeater: false,
        });
      }
      continue;
    }
    out.push({
      name: n.name, label: n.label, type: n.type, category: n.category,
      isRepeater: n.isRepeater,
      childFields: n.isRepeater && Array.isArray(n.children)
        ? n.children.map((c) => ({ name: c.name, type: c.type, category: c.category }))
        : undefined,
    });
  }
  return out;
}

// ============================================================
// Structural tags (unchanged from v3)
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
// Single-module indexer (UPDATED for v4)
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
  accessToken: string, themePath: string, moduleName: string
): Promise<ModuleEntry | null> {
  const modulePath = `${themePath}/modules/${moduleName}`;
  const warnings: string[] = [];

  // Fetch fields.json, meta.json, AND module.html in parallel
  const [fieldsJson, metaJson, hublRaw] = await Promise.all([
    fetchJsonFile<unknown>(accessToken, `${modulePath}/fields.json`),
    fetchJsonFile<MetaJson>(accessToken, `${modulePath}/meta.json`),
    fetchTextFile(accessToken, `${modulePath}/module.html`),
  ]);

  let schema: FieldNode[] = [];
  if (fieldsJson === null) {
    warnings.push("fields.json missing or unreadable");
  } else {
    schema = parseFieldsJson(fieldsJson);
  }

  // Extract render summary from HubL if available
  let renderSummary: RenderSummary | undefined;
  let renderSummaryText: string | undefined;
  let hublExcerpt: string | undefined;
  if (hublRaw && hublRaw.length > 0) {
    try {
      renderSummary = extractRenderSummary(hublRaw);
      renderSummaryText = formatRenderSummary(renderSummary);
      hublExcerpt = hublRaw.slice(0, MAX_HUBL_STORED_CHARS);
    } catch (err) {
      warnings.push(`HubL extraction failed: ${(err as Error).message}`);
    }
  } else {
    warnings.push("module.html missing or empty");
  }

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

  if (contentTypes && contentTypes.length > 0 && !contentTypes.includes("SITE_PAGE")) {
    return null;
  }
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
    label, description,
    path: modulePath,
    apiPath: stripModuleSuffix(modulePath),
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
    renderSummary,
    renderSummaryText,
    hublExcerpt,
  };
}

// ============================================================
// Top-level
// ============================================================

export async function indexTheme(
  accessToken: string, themePath: string
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