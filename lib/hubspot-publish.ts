/**
 * HubSpot publishing helpers.
 *
 * Two main operations:
 *   1. uploadImagesToFileManager — fetches each source image URL, uploads
 *      it to HubSpot's File Manager under /hubfs/portage-migrations/...,
 *      returns a map of original URL -> HubSpot URL.
 *
 *   2. createHubSpotPage — assembles a page with layoutSections referencing
 *      matched modules and creates it via the CMS Pages API.
 *
 *   3. detectStagingAvailable — probe whether content staging is usable
 *      on a portal. Returns true/false.
 *
 * Field mapping rules (must match what module-matcher produces):
 *   source="heading" → use section.heading
 *   source="text"    → use section.text
 *   source="image"   → use section.images[parseInt(value)].src (mapped to HubSpot URL)
 *   source="link"    → use section.links[parseInt(value)]
 *   source="literal" → use mapping.value
 *   source="list"    → for repeaters; left empty (manual review needed)
 */

import crypto from "crypto";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

// ============================================================
// Types — match shapes from parser, classifier, matcher
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
// Tier detection — probe content staging availability
// ============================================================

/**
 * Try a lightweight read against the content staging endpoint to determine
 * if staging is available on this portal. Returns true if staging is usable.
 *
 * We use GET /cms/v3/pages/site-pages?contentStagingState=STAGING&limit=1
 * which any tier with staging access can call. Starter tier returns 403.
 */
export async function detectStagingAvailable(accessToken: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${HUBSPOT_API_BASE}/cms/v3/pages/site-pages?limit=1&archived=false`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
      }
    );
    // If listing pages returns 200 with a special "staging" filter accepted,
    // staging is enabled. We can't perfectly tell from this single call, so
    // we use a stronger probe: try to create an empty staging page (we won't
    // — instead, we look for the staging-specific endpoint's permissions).
    if (!res.ok) return false;

    // Probe further: try the staging-specific endpoint with a staging filter.
    // If the portal lacks staging, this returns 403.
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
// Image upload to File Manager
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

/**
 * Upload one image URL to HubSpot File Manager. Returns the public URL of
 * the uploaded file, or null if upload fails.
 */
async function uploadOneImage(
  accessToken: string,
  sourceImageUrl: string,
  folderPath: string
): Promise<string | null> {
  // Step 1: fetch the original image
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

  // Step 2: upload to HubSpot
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

/**
 * Upload all unique images from a list of parsed sections.
 * Returns a map: original_image_url -> hubspot_image_url.
 * Failed uploads keep the original URL as a fallback.
 */
export async function uploadImagesToFileManager(
  accessToken: string,
  sections: ParsedSection[],
  sourceDomain: string
): Promise<Map<string, string>> {
  // Collect unique image URLs
  const uniqueUrls = new Set<string>();
  for (const s of sections) {
    for (const img of s.content.images) {
      if (img.src && img.src.startsWith("http")) uniqueUrls.add(img.src);
    }
  }

  if (uniqueUrls.size === 0) return new Map();

  const today = new Date().toISOString().slice(0, 10);
  const folder = `/portage-migrations/${sourceDomain}/${today}`;

  // Upload sequentially to be gentle on rate limits.
  // For 20+ images, this is slow but reliable. We can parallelize later.
  const result = new Map<string, string>();
  for (const url of uniqueUrls) {
    const uploadedUrl = await uploadOneImage(accessToken, url, folder);
    if (uploadedUrl) {
      result.set(url, uploadedUrl);
    } else {
      // Failed upload — fall back to original URL so the page still renders
      result.set(url, url);
    }
  }

  return result;
}

// ============================================================
// Build module field values from a section's content
// ============================================================

type ModuleParams = Record<string, unknown>;

/**
 * Resolve a single field mapping into the actual value to put in the module.
 */
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
      // Repeaters require manual handling — return empty array so HubSpot
      // creates the module with an empty repeater that the user can fill in.
      return [];

    default:
      return "";
  }
}

/**
 * Build the module params object for a single matched section.
 */
function buildModuleParams(
  section: ParsedSection,
  match: SectionMatch,
  imageUrlMap: Map<string, string>
): ModuleParams {
  const params: ModuleParams = {};
  for (const mapping of match.fieldMappings) {
    params[mapping.fieldName] = resolveFieldValue(mapping, section, imageUrlMap);
  }
  return params;
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
  sections: ParsedSection[];
  matches: SectionMatch[];
  imageUrlMap: Map<string, string>;
  // Whether to create in content staging vs. live as draft
  contentStagingState: "STAGING" | "DRAFT";
};

export type CreatePageResult = {
  ok: true;
  pageId: string;
  url?: string;
} | {
  ok: false;
  error: string;
};

/**
 * Build a single layoutSection cell containing one module instance.
 * HubSpot's layoutSections format is documented at:
 * https://developers.hubspot.com/docs/api/cms/pages
 */
function buildLayoutCell(
  cellName: string,
  moduleName: string,
  modulePath: string,
  params: ModuleParams,
  index: number
): Record<string, unknown> {
  // Each cell is one named section in layoutSections, containing rows of
  // columns with widgets. We use a simple single-column-per-row layout.
  return {
    name: cellName,
    type: "section",
    rows: [
      {
        columns: [
          {
            widgets: [
              {
                name: `${moduleName}_${index}`,
                module_id: modulePath,
                params,
                type: "module",
              },
            ],
            width: 12,
          },
        ],
      },
    ],
  };
}

export async function createHubSpotPage(
  args: CreatePageArgs
): Promise<CreatePageResult> {
  const sectionById = new Map(args.sections.map((s) => [s.id, s]));

  // Build layoutSections object
  const layoutSections: Record<string, unknown> = {};
  for (let i = 0; i < args.matches.length; i++) {
    const match = args.matches[i];
    const section = sectionById.get(match.sectionId);
    if (!section) continue;

    const params = buildModuleParams(section, match, args.imageUrlMap);
    const cellName = `cell_${i + 1}`;
    layoutSections[cellName] = buildLayoutCell(
      cellName,
      match.matchedModule,
      match.matchedModulePath,
      params,
      i
    );
  }

  const body: Record<string, unknown> = {
    name: args.pageTitle,
    htmlTitle: args.pageTitle,
    slug: args.pageSlug,
    metaDescription: args.metaDescription ?? "",
    state: "DRAFT",
    layoutSections,
  };

  // Add theme path. HubSpot uses templatePath for the layout source; we point
  // at the theme's default page template.
  // NOTE: this assumes the theme has a templates/page.html, which is convention
  // for HubSpot themes. If not, the user will need to specify a template later.
  body.templatePath = `${args.themePath}/templates/page.html`;

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