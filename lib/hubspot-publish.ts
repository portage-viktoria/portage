/**
 * HubSpot publishing helpers — v9 (reference-catalog era).
 *
 * The publisher now consumes a catalog of canonical module instances and
 * applies substitutions to their demo content rather than building params
 * from scratch.
 *
 * Per matched section:
 *   1. Look up the catalog entry's demoParams
 *   2. Deep clone them
 *   3. Apply substitutions (title, body, image, link, repeater items)
 *      using the rules locked in earlier
 *   4. Strip non-payload params (path, offset, width, etc. that belong to
 *      the {% dnd_module %} tag, not the module instance JSON)
 *   5. Emit as a single dnd_area-module-N row
 *
 * Style decisions (alignment, animation, background, container, layout,
 * button styles) are preserved verbatim from the demo.
 */

import crypto from "crypto";
import type { ReferenceCatalog, ReferenceCatalogEntry } from "./reference-catalog";
import type { Substitutions, SectionMatch } from "./reference-matcher";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

// Keys in the parsed dnd_module body that are tag-level metadata, NOT
// content fields. We strip them before publishing.
const TAG_LEVEL_KEYS = new Set(["path", "offset", "width", "full_width"]);

// ============================================================
// Types
// ============================================================

export type ParsedSection = {
  id: string;
  content: {
    heading?: string;
    text: string;
    headings: Array<{ level: number; text: string }>;
    images: Array<{ src: string; alt?: string }>;
    links: Array<{ text: string; href: string }>;
    wordCount: number;
  };
};

// Re-export so existing imports work
export type { SectionMatch } from "./reference-matcher";

// ============================================================
// Tier detection
// ============================================================

export async function detectStagingAvailable(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${HUBSPOT_API_BASE}/cms/v3/pages/site-pages?contentStagingState=STAGING&limit=1`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ============================================================
// Image upload (unchanged)
// ============================================================

function urlHash(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
}

function inferFilename(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const pathPart = parsed.pathname.split("/").pop() ?? "";
    if (pathPart && pathPart.includes(".")) return pathPart;
  } catch {}
  return fallback;
}

async function uploadOneImage(
  accessToken: string,
  sourceImageUrl: string,
  folderPath: string
): Promise<string | null> {
  let imageBytes: ArrayBuffer;
  let contentType: string;
  try {
    const res = await fetch(sourceImageUrl, {
      method: "GET",
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    imageBytes = await res.arrayBuffer();
    contentType = res.headers.get("content-type") ?? "image/png";
  } catch {
    return null;
  }

  const filename = inferFilename(sourceImageUrl, `image-${urlHash(sourceImageUrl)}.png`);
  const form = new FormData();
  form.append("file", new Blob([imageBytes], { type: contentType }), filename);
  form.append("folderPath", folderPath);
  form.append(
    "options",
    JSON.stringify({
      access: "PUBLIC_INDEXABLE",
      overwrite: false,
      duplicateValidationStrategy: "NONE",
    })
  );

  try {
    const res = await fetch(`${HUBSPOT_API_BASE}/files/v3/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      body: form,
      signal: AbortSignal.timeout(45000),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.warn(`[hubspot upload] failed ${res.status}: ${errText.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    return typeof data?.url === "string" ? data.url : null;
  } catch (err) {
    console.warn("[hubspot upload] error:", err);
    return null;
  }
}

export async function uploadImagesToFileManager(
  accessToken: string,
  sections: ParsedSection[],
  sourceDomain: string
): Promise<Map<string, string>> {
  const uniqueUrls = new Set<string>();
  for (const s of sections) {
    for (const img of s.content.images) {
      if (img.src && img.src.startsWith("http")) uniqueUrls.add(img.src);
    }
  }
  if (uniqueUrls.size === 0) return new Map();

  const today = new Date().toISOString().slice(0, 10);
  const folder = `/portage-migrations/${sourceDomain}/${today}`;

  const result = new Map<string, string>();
  for (const url of uniqueUrls) {
    const uploadedUrl = await uploadOneImage(accessToken, url, folder);
    result.set(url, uploadedUrl ?? url);
  }
  return result;
}

// ============================================================
// Substitution engine — the heart of v9
// ============================================================

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function plainTextToHtml(text: string): string {
  if (!text) return "";
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return "";
  return paragraphs
    .map(
      (p) =>
        `<p>${p
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\n/g, "<br>")}</p>`
    )
    .join("\n");
}

/**
 * Walk an object and replace any "title" string field with newTitle.
 * Operates on plain string fields only — doesn't touch title_type, etc.
 */
function substituteTitleInObject(obj: unknown, newTitle: string): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) substituteTitleInObject(item, newTitle);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "title" && typeof record[key] === "string") {
      record[key] = newTitle;
    } else if (typeof record[key] === "object" && record[key] !== null) {
      substituteTitleInObject(record[key], newTitle);
    }
  }
}

/**
 * Walk and replace any "supporting_content" field with newBody (HTML).
 */
function substituteBodyInObject(obj: unknown, newBody: string): void {
  if (obj === null || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) substituteBodyInObject(item, newBody);
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === "supporting_content" && typeof record[key] === "string") {
      record[key] = newBody;
    } else if (typeof record[key] === "object" && record[key] !== null) {
      substituteBodyInObject(record[key], newBody);
    }
  }
}

/**
 * Find the first object that has both "src" and "alt" properties (i.e. an
 * image_selection-shaped object) and replace src + alt. Returns true if a
 * substitution happened.
 */
function substituteFirstImage(
  obj: unknown,
  newSrc: string,
  newAlt: string
): boolean {
  if (obj === null || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (substituteFirstImage(item, newSrc, newAlt)) return true;
    }
    return false;
  }
  const record = obj as Record<string, unknown>;
  // Is this an image-shaped object?
  if (
    typeof record.src === "string" &&
    "alt" in record &&
    typeof record.alt === "string"
  ) {
    record.src = newSrc;
    record.alt = newAlt;
    return true;
  }
  // Recurse
  for (const key of Object.keys(record)) {
    if (typeof record[key] === "object" && record[key] !== null) {
      if (substituteFirstImage(record[key], newSrc, newAlt)) return true;
    }
  }
  return false;
}

/**
 * Find the first button-shaped object (has link.url.href and a text field)
 * and replace href + text. Returns true on success.
 */
function substituteFirstButton(
  obj: unknown,
  newHref: string,
  newText: string
): boolean {
  if (obj === null || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      if (substituteFirstButton(item, newHref, newText)) return true;
    }
    return false;
  }
  const record = obj as Record<string, unknown>;
  // Is this a button object? Has "link" with "url.href" and a "text" sibling
  if (
    "link" in record &&
    typeof record.link === "object" &&
    record.link !== null
  ) {
    const link = record.link as Record<string, unknown>;
    if (
      "url" in link &&
      typeof link.url === "object" &&
      link.url !== null &&
      "href" in (link.url as Record<string, unknown>)
    ) {
      const urlObj = link.url as Record<string, unknown>;
      urlObj.href = newHref;
      if (typeof record.text === "string" && newText) {
        record.text = newText;
      }
      return true;
    }
  }
  for (const key of Object.keys(record)) {
    if (typeof record[key] === "object" && record[key] !== null) {
      if (substituteFirstButton(record[key], newHref, newText)) return true;
    }
  }
  return false;
}

/**
 * Find a repeater field (top-level array) and adjust its length to match
 * the source's parallel items. Each item gets title/body/image/link applied
 * by mutating the demo-shaped clone.
 *
 * Strategy:
 *   - If source has N items and demo has M:
 *     - For each i in [0, N): clone demo item index i % M as base, apply substitutions
 *   - This way every produced item has a complete demo-shaped structure
 */
function applyRepeaterItems(
  params: Record<string, unknown>,
  items: NonNullable<Substitutions["repeaterItems"]>,
  imageUrlMap: Map<string, string>,
  sourceImages: Array<{ src: string; alt?: string }>,
  sourceLinks: Array<{ text: string; href: string }>
): void {
  if (items.length === 0) return;

  // Find the first top-level array — that's the repeater
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (!Array.isArray(value) || value.length === 0) continue;

    const demoItems = value;
    const newItems: unknown[] = [];

    for (let i = 0; i < items.length; i++) {
      const sourceItem = items[i];
      const demoItem = deepClone(demoItems[i % demoItems.length]);

      if (sourceItem.title) substituteTitleInObject(demoItem, sourceItem.title);
      if (sourceItem.text) substituteBodyInObject(demoItem, plainTextToHtml(sourceItem.text));
      if (typeof sourceItem.imageIdx === "number") {
        const img = sourceImages[sourceItem.imageIdx];
        if (img) {
          const finalUrl = imageUrlMap.get(img.src) ?? img.src;
          substituteFirstImage(demoItem, finalUrl, img.alt ?? "");
        }
      }
      if (typeof sourceItem.linkIdx === "number") {
        const link = sourceLinks[sourceItem.linkIdx];
        if (link) {
          substituteFirstButton(demoItem, link.href, link.text);
        }
      }

      newItems.push(demoItem);
    }

    params[key] = newItems;
    return; // Only handle the first repeater
  }

  // Special case: "icon_list" wraps its items in { item: [...] }
  if (
    params.icon_list &&
    typeof params.icon_list === "object" &&
    !Array.isArray(params.icon_list)
  ) {
    const list = params.icon_list as Record<string, unknown>;
    if (Array.isArray(list.item)) {
      const demoItems = list.item;
      const newItems: unknown[] = [];
      for (let i = 0; i < items.length; i++) {
        const sourceItem = items[i];
        const demoItem = deepClone(demoItems[i % demoItems.length]);
        if (sourceItem.title) substituteTitleInObject(demoItem, sourceItem.title);
        if (sourceItem.text) substituteBodyInObject(demoItem, plainTextToHtml(sourceItem.text));
        if (typeof sourceItem.imageIdx === "number") {
          const img = sourceImages[sourceItem.imageIdx];
          if (img) {
            const finalUrl = imageUrlMap.get(img.src) ?? img.src;
            substituteFirstImage(demoItem, finalUrl, img.alt ?? "");
          }
        }
        newItems.push(demoItem);
      }
      list.item = newItems;
    }
  }
}

/**
 * Build the final params object for one matched section.
 *
 * Algorithm:
 *   1. Take the catalog entry's demoParams, deep clone
 *   2. Strip tag-level keys (path, offset, width, full_width) — these
 *      belong on the {% dnd_module %} tag, not in the module instance JSON
 *   3. Apply substitutions:
 *      - useTitle: replace any title field with section.heading
 *      - useBody: replace any supporting_content field with section.text as HTML
 *      - primaryImageIdx: replace first image-shaped object with the source image
 *      - primaryLinkIdx: replace first button-shaped object with the source link
 *      - repeaterItems: rebuild the first top-level array repeater
 *   4. Add HubSpot's required base keys (path, schema_version, css_class)
 */
function buildModuleParams(
  section: ParsedSection,
  match: SectionMatch,
  catalogEntry: ReferenceCatalogEntry,
  imageUrlMap: Map<string, string>
): Record<string, unknown> {
  const cloned = deepClone(catalogEntry.demoParams);

  // Strip tag-level keys
  for (const key of TAG_LEVEL_KEYS) {
    delete cloned[key];
  }

  const subs = match.substitutions;

  // Apply scalar substitutions
  if (subs.useTitle && section.content.heading) {
    substituteTitleInObject(cloned, section.content.heading);
  }
  if (subs.useBody && section.content.text) {
    substituteBodyInObject(cloned, plainTextToHtml(section.content.text));
  }
  if (
    typeof subs.primaryImageIdx === "number" &&
    section.content.images[subs.primaryImageIdx]
  ) {
    const img = section.content.images[subs.primaryImageIdx];
    const finalUrl = imageUrlMap.get(img.src) ?? img.src;
    substituteFirstImage(cloned, finalUrl, img.alt ?? "");
  }
  if (
    typeof subs.primaryLinkIdx === "number" &&
    section.content.links[subs.primaryLinkIdx]
  ) {
    const link = section.content.links[subs.primaryLinkIdx];
    substituteFirstButton(cloned, link.href, link.text);
  }

  // Apply repeater items
  if (subs.repeaterItems && subs.repeaterItems.length > 0) {
    applyRepeaterItems(
      cloned,
      subs.repeaterItems,
      imageUrlMap,
      section.content.images,
      section.content.links
    );
  }

  // Required HubSpot base keys for module instance
  cloned.path = match.modulePath;
  cloned.schema_version = 2;
  cloned.css_class = "dnd-module";

  return cloned;
}

// ============================================================
// Build layoutSections
// ============================================================

type LayoutPayload = {
  dnd_area: Record<string, unknown>;
};

function buildLayoutSections(
  sections: ParsedSection[],
  matches: SectionMatch[],
  imageUrlMap: Map<string, string>,
  catalog: ReferenceCatalog
): LayoutPayload {
  const sectionById = new Map(sections.map((s) => [s.id, s]));
  const entryById = new Map(catalog.entries.map((e) => [e.id, e]));

  const rows: Array<Record<string, unknown>> = [];
  const rowMetaData: Array<Record<string, unknown>> = [];

  matches.forEach((match, i) => {
    const section = sectionById.get(match.sectionId);
    if (!section) return;
    if (!match.entryId) return;

    const entry = entryById.get(match.entryId);
    if (!entry) return;

    const params = buildModuleParams(section, match, entry, imageUrlMap);
    const moduleName = `dnd_area-module-${i + 1}`;

    rows.push({
      "0": {
        name: moduleName,
        type: "custom_widget",
        params,
        cells: [],
        rows: [],
        rowMetaData: [],
        w: 12,
        x: 0,
      },
    });
    rowMetaData.push({ cssClass: "dnd-section" });
  });

  return {
    dnd_area: {
      name: "dnd_area",
      type: "cell",
      label: "Main section",
      cells: [],
      cssClass: "",
      cssId: "",
      cssStyle: "",
      params: {},
      rowMetaData,
      rows,
      w: 12,
      x: 0,
    },
  };
}

// ============================================================
// Create the page
// ============================================================

export type CreatePageArgs = {
  accessToken: string;
  pageTitle: string;
  pageSlug: string;
  metaDescription?: string;
  themeName: string;          // project's theme name (used for templatePath)
  templateName: string;        // e.g. "migration.html"
  sections: ParsedSection[];
  matches: SectionMatch[];
  imageUrlMap: Map<string, string>;
  contentStagingState: "STAGING" | "DRAFT";
  catalog: ReferenceCatalog;
};

export type CreatePageResult =
  | { ok: true; pageId: string; url?: string }
  | { ok: false; error: string };

function cleanPath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

export async function createHubSpotPage(args: CreatePageArgs): Promise<CreatePageResult> {
  const layoutSections = buildLayoutSections(
    args.sections,
    args.matches,
    args.imageUrlMap,
    args.catalog
  );

  const cleanTheme = cleanPath(args.themeName);
  const cleanTemplate = cleanPath(args.templateName);
  const templatePath = `${cleanTheme}/templates/${cleanTemplate}`;

  const body: Record<string, unknown> = {
    name: args.pageTitle,
    htmlTitle: args.pageTitle,
    slug: args.pageSlug,
    metaDescription: args.metaDescription ?? "",
    state: "DRAFT",
    layoutSections,
    templatePath,
  };

  if (args.contentStagingState === "STAGING") {
    body.contentStagingState = "STAGING";
  }

  try {
    const res = await fetch(`${HUBSPOT_API_BASE}/cms/v3/pages/site-pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      const errText = await res.text();
      return {
        ok: false,
        error: `HubSpot page creation failed (${res.status}): ${errText.slice(0, 500)}`,
      };
    }

    const data = await res.json();
    return {
      ok: true,
      pageId: typeof data.id === "string" ? data.id : "",
      url: typeof data.url === "string" ? data.url : undefined,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Network error creating HubSpot page: ${(err as Error).message}`,
    };
  }
}