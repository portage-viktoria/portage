/**
 * HubSpot publishing helpers — v3.
 *
 * Adds templateName parameter to createHubSpotPage so callers can specify
 * which template the page should use. Defaults to migration.html convention.
 *
 * The template at <theme>/templates/<templateName> must contain a
 * {% dnd_area "dnd_area" %}{% end_dnd_area %} block — that's the slot our
 * layoutSections payload populates.
 */

import crypto from "crypto";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

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
      return { src: finalUrl, alt: img.alt ?? "" };
    }
    case "link": {
      const idx = parseInt(mapping.value ?? "0", 10);
      const link = section.content.links[isNaN(idx) ? 0 : idx];
      if (!link) return null;
      return { url: { href: link.href, type: "EXTERNAL" }, text: link.text };
    }
    case "literal":
      return mapping.value ?? "";
    case "list":
      return [];
    default:
      return "";
  }
}

function buildModuleParams(
  section: ParsedSection,
  match: SectionMatch,
  imageUrlMap: Map<string, string>
): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const mapping of match.fieldMappings) {
    params[mapping.fieldName] = resolveFieldValue(mapping, section, imageUrlMap);
  }
  return params;
}

// ============================================================
// Build layoutSections — uses dnd_area as the section name
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
    const widgetName = `widget_${i + 1}`;
    const columnName = `dnd_area-column-${i + 1}`;

    const columnObject = {
      name: columnName,
      type: "cell",
      params: { css_class: "dnd-column" },
      cells: [],
      rowMetaData: [{ cssClass: "dnd-row" }],
      rows: [
        {
          "0": {
            name: widgetName,
            type: "cell",
            cells: [
              {
                name: widgetName,
                type: "custom_widget",
                widget_name: widgetName,
                widget_type: "module",
                module_id: match.matchedModulePath,
                params,
              },
            ],
          },
        },
      ],
    };

    rows.push({ "0": columnObject });
    rowMetaData.push({ cssClass: "dnd-section" });
  });

  return {
    dnd_area: {
      name: "dnd_area",
      type: "section",
      label: "Main section",
      cells: [],
      params: {},
      rowMetaData,
      rows,
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
  templateName: string;          // e.g. "migration.html"
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

  const body: Record<string, unknown> = {
    name: args.pageTitle,
    htmlTitle: args.pageTitle,
    slug: args.pageSlug,
    metaDescription: args.metaDescription ?? "",
    state: "DRAFT",
    layoutSections,
    templatePath: `${args.themePath}/templates/${args.templateName}`,
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