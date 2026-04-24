/**
 * Themes listing route.
 *
 * GET /api/portals/[hubId]/themes
 *
 * Scans the portal's Design Manager for every folder containing a theme.json
 * file. Themes can live in several places:
 *   - Root-level custom themes:  /my-custom-theme/
 *   - Marketplace themes:        /@marketplace/<publisher>/<theme-name>/
 *   - Nested child themes:       /my-theme/child-theme/
 *
 * The scanner walks the folder tree top-down. When it finds a theme.json, it
 * records that folder as a theme and STOPS recursing into it (themes don't
 * contain other themes — the subfolders inside are modules, partials, etc.).
 *
 * Depth is capped at 4 levels and concurrent requests are limited to stay
 * well within HubSpot's rate limits. Results are returned in alphabetical
 * order by label.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/portal-connections";

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const MAX_DEPTH = 4;
const CONCURRENCY = 5; // max simultaneous API requests

type SourceCodeMetadata = {
  folder?: boolean;
  path?: string;
  name?: string;
  children?: string[];
};

type ThemeJsonPartial = {
  label?: string;
  preview_path?: string;
  screenshot_path?: string;
  author?: string;
  version?: string;
};

type DiscoveredTheme = {
  path: string;
  label: string;
  source: "marketplace" | "custom" | "nested";
  author?: string;
};

// Small concurrency limiter — processes an array of tasks with a cap on
// how many run in parallel. Prevents us from firing 50 HubSpot requests at
// once when a portal has a lot of folders.
async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await task(items[index]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

async function fetchMetadata(
  accessToken: string,
  path: string
): Promise<SourceCodeMetadata | null> {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/metadata/${encodedPath}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    console.warn(`[themes] metadata ${path} returned ${res.status}`);
    return null;
  }
  return res.json();
}

async function fetchThemeJson(
  accessToken: string,
  themePath: string
): Promise<ThemeJsonPartial | null> {
  const encodedPath = themePath.split("/").map(encodeURIComponent).join("/");
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/content/${encodedPath}/theme.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/octet-stream",
    },
  });
  if (!res.ok) return null;
  try {
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function classifyThemeSource(path: string): "marketplace" | "custom" | "nested" {
  if (path.startsWith("@marketplace/")) return "marketplace";
  if (path.includes("/")) return "nested"; // e.g., child theme inside another folder
  return "custom";
}

/**
 * Recursively walk a folder, collecting every theme.json found along the way.
 * Stops descending into a folder once its theme.json is found.
 */
async function discoverThemes(
  accessToken: string,
  folderPath: string,
  depth: number
): Promise<DiscoveredTheme[]> {
  if (depth > MAX_DEPTH) return [];

  // First check: does THIS folder have a theme.json?
  // (Skip this check at the very root — "" has no theme.json by definition)
  if (folderPath !== "") {
    const themeJson = await fetchThemeJson(accessToken, folderPath);
    if (themeJson) {
      return [
        {
          path: folderPath,
          label: themeJson.label ?? folderPath.split("/").pop() ?? folderPath,
          source: classifyThemeSource(folderPath),
          author: themeJson.author,
        },
      ];
    }
  }

  // No theme.json here — list children and recurse into each
  const metadata = await fetchMetadata(accessToken, folderPath);
  if (!metadata?.children || metadata.children.length === 0) return [];

  // Skip well-known non-theme folders at the root to save API calls
  const ignoredAtRoot = new Set([
    "@hubspot",
    "@hubspot-platform",
    "@system",
    "_hcms",
    "images",
    "img",
    "files",
  ]);

  const childrenToScan = metadata.children.filter((child) => {
    if (folderPath === "" && ignoredAtRoot.has(child)) return false;
    return true;
  });

  const childPaths = childrenToScan.map((child) =>
    folderPath === "" ? child : `${folderPath}/${child}`
  );

  const discovered = await parallelLimit(childPaths, CONCURRENCY, (path) =>
    discoverThemes(accessToken, path, depth + 1)
  );

  return discovered.flat();
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hubId: string }> }
) {
  const { hubId } = await params;
  const hubIdNum = parseInt(hubId, 10);

  if (isNaN(hubIdNum)) {
    return NextResponse.json({ error: "Invalid hub_id" }, { status: 400 });
  }

  const userId: string | null = null;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(userId, hubIdNum);
  } catch (err) {
    console.error("[themes] failed to get access token:", err);
    return NextResponse.json(
      { error: "Portal not connected" },
      { status: 404 }
    );
  }

  try {
    const themes = await discoverThemes(accessToken, "", 0);
    themes.sort((a, b) => a.label.localeCompare(b.label));
    return NextResponse.json({ themes });
  } catch (err) {
    console.error("[themes] scan failed:", err);
    return NextResponse.json(
      { error: "Failed to scan themes" },
      { status: 500 }
    );
  }
}