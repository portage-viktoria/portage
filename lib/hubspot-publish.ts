/**
 * HubSpot publishing helpers — v5.
 *
 * Final correct layoutSections shape, modeled directly after a real HubSpot
 * page's JSON response. See the diagnostic dump for reference.
 *
 * Each module placement is a "custom_widget" type cell, with the module's
 * path AND its field values both living inside params. The module's identity
 * is the path string — module_id (a numeric HubSpot ID) is optional because
 * HubSpot auto-resolves the path.
 */

import crypto from "crypto";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

function cleanPath(p: string): string {
  return p.replace(/^\/+/, "").replace(/\/+$/, "");
}

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

export type FieldMapping = {
  fieldName: string;
  fieldType: string;
  source: "heading" | "text" | "image" | "link" | "literal" | "list";
  value?: string;
  description: string;
};

export type SectionMatch = {
  sectionId: string;
  matchedModule: string;
  matchedModulePath: string;
  confidence: number;
  reasoning: string;
  fieldMappings: FieldMapping[];
  isFallback: boolean;
};

// ============================================================
// Tier detection
// ============================================================

export async function detectStagingAvailable(accessToken: string): Promise<boolean> {
  try {
    const stageProbe = await fetch(
      `${HUBSPOT_API_BASE}/cms/v3/pages/site-pages?contentStagingState=STAGING&limit=1`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );
    return stageProbe.ok;
  } catch {
    return false;
  }
}

// ============================================================
// Image upload
// ============================================================

function urlHash(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 12);
}

function inferFilename(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const pathPart = parsed.pathname.split("/").pop() ?? "";
    if (pathPart && pathPart.includes(".")) return pathPart;
  } catch {
    // ignore
  }
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
    JSON.stringify({ access: "PUBLIC_INDEXABLE", overwrite: false, duplicateValidationStrategy: "NONE" })
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
// Field value resolution
// ============================================================

function resolveFieldValue(
  mapping: FieldMapping,
  section: ParsedSection,
  imageUrlMap: Map<string, string>
): unknown {
  switch (mapping.source) {
    case "heading":
      return section.content.heading ?? "";
    case "text":
      return section.content.text ?? "";
    case "image": {
      const idx = parseInt(mapping.value ?? "0", 10);
      const img = section.content.images[isNaN(idx) ? 0 : idx];
      if (!img) return "";
      const finalUrl = imageUrlMap.get(img.src) ?? img.src;
      // HubSpot's image field expects this shape
      return { src: finalUrl, alt: img.alt ?? "" };
    }
    case "link": {
      const idx = parseInt(mapping.value ?? "0", 10);
      const link = section.content.links[isNaN(idx) ? 0 : idx];
      if (!link) return null;
      // Real HubSpot link field shape (from the dump):
      // { url: { href, href_with_scheme, type }, no_follow, open_in_new_tab, ... }
      return {
        url: {
          href: link.href,
          href_with_scheme: link.href,
          type: "EXTERNAL",
        },
        no_follow: false,
        open_in_new_tab: false,
        rel: "",
        sponsored: false,
        user_generated_content: false,
      };
    }
    case "literal":
      return mapping.value ?? "";
    case "list":
      return [];
    default:
      return "";
  }
}

/**
 * Build the params object for one module instance.
 *
 * The module's own field values live as flat keys alongside the boilerplate
 * (path, css_class, schema_version, etc.). This matches the real shape from
 * the HubSpot API response.
 */
function buildModuleParams(
  section: ParsedSection,
  match: SectionMatch,
  imageUrlMap: Map<string, string>
): Record<string, unknown> {
  // Boilerplate that every module cell carries
  const params: Record<string, unknown> = {
    child_css: {},
    css: {},
    css_class: "dnd-module",
    path: match.matchedModulePath,
    schema_version: 2,
    smart_objects: [],
    smart_type: "NOT_SMART",
    wrap_field_tag: "div",
  };

  // Field values, flattened directly into params
  for (const mapping of match.fieldMappings) {
    params[mapping.fieldName] = resolveFieldValue(mapping, section, imageUrlMap);
  }

  return params;
}

// ============================================================
// Build layoutSections — final correct shape
// ============================================================

type LayoutPayload = {
  dnd_area: Record<string, unknown>;
};

function buildLayoutSections(
  sections: ParsedSection[],
  matches: SectionMatch[],
  imageUrlMap: Map<string, string>
): LayoutPayload {
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  const rows: Array<Record<string, unknown>> = [];
  const rowMetaData: Array<Record<string, unknown>> = [];

  matches.forEach((match, i) => {
    const section = sectionById.get(match.sectionId);
    if (!section) return;

    const params = buildModuleParams(section, match, imageUrlMap);

    // The module cell. type is "custom_widget", x=0 w=12 for full-width,
    // params holds both the path and the field values.
    const moduleCell = {
      cells: [],
      cssClass: "",
      cssId: "",
      cssStyle: "",
      name: `dnd_area-module-${i + 1}`,
      params,
      rowMetaData: [],
      rows: [],
      type: "custom_widget",
      w: 12,
      x: 0,
    };

    // Each row holds one full-width cell at column index "0"
    rows.push({ "0": moduleCell });
    rowMetaData.push({ cssClass: "dnd-section" });
  });

  return {
    // The key MUST match the {% dnd_area "..." %} name in the template.
    // Our migration.html uses {% dnd_area "dnd_area" %} so the key is "dnd_area".
    dnd_area: {
      cells: [],
      cssClass: "",
      cssId: "",
      cssStyle: "",
      label: "Main section",
      name: "dnd_area",
      params: {},
      rowMetaData,
      rows,
      type: "cell",
      w: 12,
      x: 0,
    },
  };
}

// ============================================================
// Create the HubSpot page
// ============================================================

export type CreatePageArgs = {
  accessToken: string;
  pageTitle: string;
  pageSlug: string;
  metaDescription?: string;
  themePath: string;
  templateName: string;
  sections: ParsedSection[];
  matches: SectionMatch[];
  imageUrlMap: Map<string, string>;
  contentStagingState: "STAGING" | "DRAFT";
};

export type CreatePageResult =
  | { ok: true; pageId: string; url?: string }
  | { ok: false; error: string };

export async function createHubSpotPage(args: CreatePageArgs): Promise<CreatePageResult> {
  const layoutSections = buildLayoutSections(args.sections, args.matches, args.imageUrlMap);

  const cleanThemePath = cleanPath(args.themePath);
  const cleanTemplate = cleanPath(args.templateName);
  const templatePath = `${cleanThemePath}/templates/${cleanTemplate}`;

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