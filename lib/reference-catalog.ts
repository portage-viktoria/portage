/**
 * Reference catalog parser.
 *
 * Reads `reference/bluleadz-modules.html` and builds a catalog of the
 * curated module instances. Each catalog entry contains:
 *
 *   - id: a unique identifier derived from the MODULE label
 *   - label: the human-readable module name from the MODULE line
 *   - path: the original PATH from the comment block (with default theme name)
 *   - moduleName: the trailing portion of the path (e.g. "Two Column w Image")
 *   - useWhen: the USE WHEN paragraph as a single string
 *   - mainFields: a textual list of fields (kept for matcher prompt)
 *   - notes: any extra notes from the comment
 *   - demoParams: the parsed demo params object — this is what the publisher
 *                 deep-clones and uses as the canonical instance
 *
 * The parser is in-memory cached. Call clearCatalogCache() to force a re-parse.
 */

import { promises as fs } from "fs";
import path from "path";

// ============================================================
// Types
// ============================================================

export type ReferenceCatalogEntry = {
  id: string;
  label: string;
  path: string;
  moduleName: string;
  useWhen: string;
  mainFields: string;
  notes?: string;
  demoParams: Record<string, unknown>;
};

export type ReferenceCatalog = {
  entries: ReferenceCatalogEntry[];
  defaultThemeName: string;
  loadedAt: string;
};

// ============================================================
// In-memory cache
// ============================================================

let cachedCatalog: ReferenceCatalog | null = null;

export function clearCatalogCache(): void {
  cachedCatalog = null;
}

// ============================================================
// Public API
// ============================================================

const REFERENCE_FILENAME = "bluleadz-modules.html";
const REFERENCE_FOLDER = "reference";
const DEFAULT_THEME_NAME = "Bluleadz Starter Theme - LP v2";

export async function loadCatalog(): Promise<ReferenceCatalog> {
  if (cachedCatalog) return cachedCatalog;

  const filepath = path.join(process.cwd(), REFERENCE_FOLDER, REFERENCE_FILENAME);

  let fileText: string;
  try {
    fileText = await fs.readFile(filepath, "utf8");
  } catch (err) {
    throw new Error(
      `Couldn't read reference template at ${filepath}: ${(err as Error).message}`
    );
  }

  const entries = parseReferenceTemplate(fileText);
  if (entries.length === 0) {
    throw new Error("Reference template parsed to zero entries — check formatting");
  }

  cachedCatalog = {
    entries,
    defaultThemeName: DEFAULT_THEME_NAME,
    loadedAt: new Date().toISOString(),
  };
  return cachedCatalog;
}

export function findEntryById(catalog: ReferenceCatalog, id: string): ReferenceCatalogEntry | null {
  return catalog.entries.find((e) => e.id === id) ?? null;
}

/**
 * Swap the default theme name in a path for the project's actual theme name.
 * E.g. "/Bluleadz Starter Theme - LP v2/modules/Hero" → "/{themeName}/modules/Hero"
 */
export function rewritePathForTheme(originalPath: string, themeName: string): string {
  const normalized = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
  // Replace the segment between the first "/" and "/modules/"
  const modulesIdx = normalized.indexOf("/modules/");
  if (modulesIdx === -1) return normalized;
  return `/${themeName}${normalized.slice(modulesIdx)}`;
}

// ============================================================
// Parser — extracts MODULE comment blocks paired with {% dnd_module %} tags
// ============================================================

type ParsedComment = {
  module: string;
  path: string;
  useWhen: string;
  mainFields: string;
  notes?: string;
  blockEnd: number; // position in source where the comment ends
};

export function parseReferenceTemplate(source: string): ReferenceCatalogEntry[] {
  const entries: ReferenceCatalogEntry[] = [];
  const seenIds = new Set<string>();

  // Find all {# ... #} comment blocks that contain "MODULE:"
  const commentRegex = /\{#\s*([\s\S]*?)\s*#\}/g;
  let match: RegExpExecArray | null;

  while ((match = commentRegex.exec(source)) !== null) {
    const commentBody = match[1];
    if (!/MODULE:/i.test(commentBody)) continue;

    const parsed = parseCommentBlock(commentBody, commentRegex.lastIndex);
    if (!parsed) continue;

    // After the comment, find the next {% dnd_module ... %} ... {% end_dnd_module %}
    const moduleBlock = findNextDndModuleBlock(source, parsed.blockEnd);
    if (!moduleBlock) {
      console.warn(`[reference-catalog] no {% dnd_module %} block after MODULE: ${parsed.module}`);
      continue;
    }

    // Parse the module block's named-param assignments into a JS object
    const demoParams = parseDndModuleParams(moduleBlock.body);

    // Derive a unique ID
    const baseId = slugify(parsed.module);
    let id = baseId;
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${baseId}-${suffix++}`;
    }
    seenIds.add(id);

    const moduleName = extractModuleName(parsed.path);

    entries.push({
      id,
      label: parsed.module,
      path: parsed.path,
      moduleName,
      useWhen: parsed.useWhen,
      mainFields: parsed.mainFields,
      notes: parsed.notes,
      demoParams,
    });
  }

  return entries;
}

function parseCommentBlock(body: string, blockEnd: number): ParsedComment | null {
  // Extract MODULE, PATH, USE WHEN, MAIN FIELDS, NOTES sections
  const lines = body.split("\n").map((l) => l.trim());

  let module = "";
  let pathStr = "";
  const sections: Record<string, string[]> = {
    USE_WHEN: [],
    FEATURES: [],
    MAIN_FIELDS: [],
    STYLE_FIELDS: [],
    NOTES: [],
  };
  let currentSection: keyof typeof sections | null = null;

  for (const line of lines) {
    if (/^MODULE:/i.test(line)) {
      module = line.replace(/^MODULE:\s*/i, "").trim();
      currentSection = null;
      continue;
    }
    if (/^PATH:/i.test(line)) {
      pathStr = line.replace(/^PATH:\s*/i, "").trim();
      currentSection = null;
      continue;
    }
    if (/^USE WHEN:?$/i.test(line)) {
      currentSection = "USE_WHEN";
      continue;
    }
    if (/^FEATURES:?$/i.test(line)) {
      currentSection = "FEATURES";
      continue;
    }
    if (/^MAIN FIELDS:?$/i.test(line)) {
      currentSection = "MAIN_FIELDS";
      continue;
    }
    if (/^STYLE FIELDS:?$/i.test(line)) {
      currentSection = "STYLE_FIELDS";
      continue;
    }
    if (/^NOTES:?$/i.test(line)) {
      currentSection = "NOTES";
      continue;
    }

    if (currentSection && line.length > 0) {
      sections[currentSection].push(line);
    }
  }

  if (!module || !pathStr) return null;

  return {
    module,
    path: pathStr,
    useWhen: sections.USE_WHEN.join(" ").trim(),
    mainFields: sections.MAIN_FIELDS.join("\n").trim(),
    notes: sections.NOTES.length > 0 ? sections.NOTES.join(" ").trim() : undefined,
    blockEnd,
  };
}

function findNextDndModuleBlock(
  source: string,
  startIdx: number
): { body: string; endIdx: number } | null {
  // Find {% dnd_module ... %} ... {% end_dnd_module %} starting after startIdx.
  // The body is the args portion between "dnd_module" and the closing "%}".
  const moduleStart = source.indexOf("{% dnd_module", startIdx);
  if (moduleStart === -1) return null;

  // Find the closing "%}" for the opening tag — but watch out for nested braces
  // inside the params (e.g. JSON objects with "{...}").
  let depth = 0;
  let i = moduleStart + "{% dnd_module".length;
  let foundClose = -1;
  while (i < source.length) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      if (depth === 0 && source[i + 1] === "%" && source[i - 0] === "}") {
        // Wait — we want to find "%}" but braces inside JSON are also "{" and "}".
        // We're looking for "%}" at depth 0.
        // But "%}" is two chars: % then }
        // so we need to check: at this position, source[i-1] === "%" and source[i] === "}"
        // and depth must be 0
      }
      depth--;
    }
    // Better approach: look for "%}" at depth 0
    if (source[i] === "%" && source[i + 1] === "}" && depth === 0) {
      foundClose = i + 2;
      break;
    }
    i++;
  }

  if (foundClose === -1) return null;

  const body = source.slice(moduleStart + "{% dnd_module".length, foundClose - 2);
  return { body, endIdx: foundClose };
}

/**
 * Parse the body of a {% dnd_module ... %} tag into an object.
 *
 * The body looks like:
 *   path="...",
 *   offset=0,
 *   width=12,
 *   content={ ...JSON-like... },
 *   image={ ... },
 *   styles={ ... }
 *
 * We need to handle: string values, number values, boolean values, JSON-like
 * objects, and JSON-like arrays. The JSON-like portions are JSON-compatible
 * (HubSpot writes them with double quotes).
 */
export function parseDndModuleParams(body: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  let i = 0;
  while (i < body.length) {
    // Skip whitespace and commas
    while (i < body.length && /[\s,]/.test(body[i])) i++;
    if (i >= body.length) break;

    // Read a key
    const keyStart = i;
    while (i < body.length && /[a-zA-Z0-9_]/.test(body[i])) i++;
    const key = body.slice(keyStart, i);
    if (!key) {
      i++;
      continue;
    }

    // Skip whitespace then expect "="
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== "=") {
      // Not an assignment; skip this token
      continue;
    }
    i++; // consume "="

    // Skip whitespace
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;

    // Read a value
    const ch = body[i];
    let value: unknown;

    if (ch === '"' || ch === "'") {
      // String value
      const { str, end } = readQuotedString(body, i);
      value = str;
      i = end;
    } else if (ch === "{") {
      // Object
      const { json, end } = readBalanced(body, i, "{", "}");
      value = parseJsonLike(json);
      i = end;
    } else if (ch === "[") {
      // Array
      const { json, end } = readBalanced(body, i, "[", "]");
      value = parseJsonLike(json);
      i = end;
    } else {
      // Number, boolean, or bareword
      const valStart = i;
      while (i < body.length && !/[\s,]/.test(body[i])) i++;
      const raw = body.slice(valStart, i);
      if (raw === "true") value = true;
      else if (raw === "false") value = false;
      else if (raw === "null") value = null;
      else if (/^-?\d+(\.\d+)?$/.test(raw)) value = parseFloat(raw);
      else value = raw;
    }

    result[key] = value;
  }

  return result;
}

function readQuotedString(source: string, start: number): { str: string; end: number } {
  const quote = source[start];
  let i = start + 1;
  let out = "";
  while (i < source.length) {
    if (source[i] === "\\" && i + 1 < source.length) {
      out += source[i + 1];
      i += 2;
      continue;
    }
    if (source[i] === quote) {
      return { str: out, end: i + 1 };
    }
    out += source[i];
    i++;
  }
  return { str: out, end: i };
}

function readBalanced(
  source: string,
  start: number,
  open: string,
  close: string
): { json: string; end: number } {
  let depth = 0;
  let i = start;
  let inString = false;
  let stringChar = "";

  while (i < source.length) {
    const ch = source[i];

    if (inString) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      i++;
      continue;
    }

    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        return { json: source.slice(start, i + 1), end: i + 1 };
      }
    }
    i++;
  }

  return { json: source.slice(start), end: i };
}

function parseJsonLike(text: string): unknown {
  // The text is JSON-compatible already (HubSpot uses double quotes).
  try {
    return JSON.parse(text);
  } catch {
    // Try lenient parsing: replace single quotes with double, strip trailing commas
    const cleaned = text
      .replace(/,(\s*[}\]])/g, "$1")
      .replace(/'/g, '"');
    try {
      return JSON.parse(cleaned);
    } catch {
      console.warn("[reference-catalog] couldn't parse JSON-like:", text.slice(0, 100));
      return null;
    }
  }
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function extractModuleName(pathStr: string): string {
  const parts = pathStr.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? pathStr;
}