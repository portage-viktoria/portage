/**
 * Portal verification — checks that all reference catalog modules exist
 * in a connected portal's theme.
 *
 * The check uses HubSpot's source-code metadata endpoint per module.
 * Each catalog module path (rewritten with the project's theme name) is
 * queried; missing ones are surfaced as warnings.
 *
 * The result is stored in portal_connections.verification_json so we don't
 * re-check on every match call.
 */

import { loadCatalog, rewritePathForTheme } from "./reference-catalog";

const HUBSPOT_API_BASE = "https://api.hubapi.com";
const VERIFICATION_TIMEOUT_MS = 5000;
const CONCURRENCY = 4;

export type ModuleVerification = {
  moduleName: string;
  expectedPath: string;
  exists: boolean;
  statusCode?: number;
};

export type PortalVerificationResult = {
  themeName: string;
  checkedAt: string;
  allModulesPresent: boolean;
  modules: ModuleVerification[];
  missingCount: number;
};

function encodePath(p: string): string {
  // Strip leading slash, encode each segment
  return p.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
}

async function checkOneModule(
  accessToken: string,
  modulePath: string
): Promise<ModuleVerification> {
  // HubSpot stores module folders with .module suffix on the disk side, but
  // the API path doesn't always require it. Try both.
  const moduleName = modulePath.split("/").pop() ?? "";

  for (const variant of [modulePath, `${modulePath}.module`]) {
    const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/metadata/${encodePath(variant)}`;
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(VERIFICATION_TIMEOUT_MS),
      });
      if (res.ok) {
        return {
          moduleName,
          expectedPath: modulePath,
          exists: true,
          statusCode: res.status,
        };
      }
      // Continue trying the next variant
    } catch {
      // Fall through to try the next variant
    }
  }

  return {
    moduleName,
    expectedPath: modulePath,
    exists: false,
    statusCode: 404,
  };
}

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

export async function verifyPortalAgainstCatalog(
  accessToken: string,
  themeName: string
): Promise<PortalVerificationResult> {
  const catalog = await loadCatalog();

  // Collect unique module paths (the catalog has 11 entries but only 10 unique
  // module names since "One Column" appears twice)
  const uniquePaths = new Set<string>();
  for (const entry of catalog.entries) {
    const rewritten = rewritePathForTheme(entry.path, themeName);
    uniquePaths.add(rewritten);
  }

  const pathsArray = Array.from(uniquePaths);
  const verifications = await parallelLimit(pathsArray, CONCURRENCY, (p) =>
    checkOneModule(accessToken, p)
  );

  const missingCount = verifications.filter((v) => !v.exists).length;

  return {
    themeName,
    checkedAt: new Date().toISOString(),
    allModulesPresent: missingCount === 0,
    modules: verifications,
    missingCount,
  };
}