/**
 * Portage landing page — module indexing milestone.
 *
 * After a theme path is validated, the user can index its modules. The result
 * is cached server-side and rendered as a searchable, filterable catalog.
 *
 * Defensive throughout — every server response field is guarded before render.
 */

"use client";

import {
  useEffect,
  useState,
  useMemo,
  Component,
  ReactNode,
} from "react";
import {
  Link2,
  Check,
  AlertCircle,
  Loader2,
  Info,
  X,
  ArrowRight,
  Search,
  Layers,
  Image as ImageIcon,
  Type,
  MousePointer2,
  Hash,
  Palette,
  Sparkles,
  Repeat,
  CheckSquare,
  Film,
  Component as ComponentIcon,
  RefreshCw,
} from "lucide-react";

// ============================================================
// Types — must match what the API returns
// ============================================================

type Validated = {
  ok: true;
  path: string;
  label: string;
  author?: string;
  version?: string;
  description?: string;
  source: "marketplace" | "nested" | "custom";
};

type ValidationError = { ok: false; error: string; hint?: string };

type ValidationState =
  | { status: "idle" }
  | { status: "validating" }
  | { status: "success"; data: Validated }
  | { status: "error"; error: ValidationError };

type FieldCategory =
  | "text" | "image" | "link" | "choice" | "color"
  | "number" | "icon" | "embed" | "repeater" | "group" | "other";

type FieldSummary = { type: string; category: FieldCategory; count: number };

type StructuralTag =
  | "hero" | "accordion" | "tabs" | "card-grid" | "feature-list"
  | "cta-banner" | "testimonial" | "logo-strip" | "stats" | "gallery"
  | "form" | "rich-text" | "menu" | "blog-listing" | "unknown";

type ModuleEntry = {
  name: string;
  label: string;
  description?: string;
  path: string;
  fields: FieldSummary[];
  hasRepeater: boolean;
  totalFields: number;
  tags: StructuralTag[];
  metaTags?: string[];
  warnings: string[];
};

type IndexResult = {
  ok: true;
  themePath: string;
  modules: ModuleEntry[];
  moduleCount: number;
  warnings: string[];
  scannedAt: string;
  cached?: boolean;
};

type IndexState =
  | { status: "idle" }
  | { status: "indexing" }
  | { status: "success"; data: IndexResult }
  | { status: "error"; error: string };

// ============================================================
// Defensive helpers
// ============================================================

function safeString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t.length > 0 ? t : null;
}

class SafeRender extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  constructor(p: { children: ReactNode; fallback: ReactNode }) {
    super(p);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(e: Error) { console.error("[SafeRender] caught:", e); }
  render() { return this.state.hasError ? this.props.fallback : this.props.children; }
}

// ============================================================
// Page
// ============================================================

export default function Home() {
  const [hubId, setHubId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [themePath, setThemePath] = useState("");
  const [validation, setValidation] = useState<ValidationState>({ status: "idle" });
  const [showHelp, setShowHelp] = useState(false);

  const [indexState, setIndexState] = useState<IndexState>({ status: "idle" });

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const c = params.get("connected");
    const e = params.get("connect_error");
    if (e) setConnectError(e);
    if (c) setHubId(c);
  }, []);

  // Reset validation when path changes
  useEffect(() => {
    if (validation.status === "success" || validation.status === "error") {
      setValidation({ status: "idle" });
      setIndexState({ status: "idle" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themePath]);

  // Try loading cached index on successful validation
  useEffect(() => {
    if (validation.status !== "success" || !hubId) return;
    const path = validation.data.path;
    fetch(
      `/api/portals/${hubId}/index-theme?path=${encodeURIComponent(path)}`,
      { method: "GET" }
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.ok) {
          setIndexState({ status: "success", data });
        }
      })
      .catch(() => { /* silent — cache miss is normal */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validation.status, hubId]);

  async function validate() {
    if (!hubId || themePath.trim().length === 0) return;
    setValidation({ status: "validating" });
    setIndexState({ status: "idle" });
    try {
      const res = await fetch(`/api/portals/${hubId}/validate-theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: themePath }),
      });
      const data = await res.json();
      if (data && data.ok === true) setValidation({ status: "success", data });
      else if (data && data.ok === false) setValidation({ status: "error", error: data });
      else setValidation({ status: "error", error: { ok: false, error: "Unexpected response" } });
    } catch {
      setValidation({ status: "error", error: { ok: false, error: "Couldn't reach the server." } });
    }
  }

  async function indexModules() {
    if (validation.status !== "success" || !hubId) return;
    setIndexState({ status: "indexing" });
    try {
      const res = await fetch(`/api/portals/${hubId}/index-theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: validation.data.path }),
      });
      const data = await res.json();
      if (data && data.ok === true) setIndexState({ status: "success", data });
      else setIndexState({ status: "error", error: safeString(data?.error) ?? "Indexing failed." });
    } catch {
      setIndexState({ status: "error", error: "Couldn't reach the server." });
    }
  }

  return (
    <main className="min-h-screen py-16 px-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-3xl mx-auto">
        <div className="mb-10">
          <div
            className="inline-flex items-center gap-2 mb-4"
            style={{ color: "#C8512A", fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.1em" }}
          >
            <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ backgroundColor: "#1A1814" }}>
              <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: "#C8512A" }} />
            </div>
            <span className="uppercase">Portage</span>
          </div>
          <h1 className="text-3xl font-medium" style={{ color: "#1A1814", letterSpacing: "-0.02em" }}>
            Connect your portal, then point Portage at a theme.
          </h1>
        </div>

        {connectError && (
          <div className="mb-6 p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm font-medium">Connection error</div>
              <div className="text-sm mt-0.5 opacity-80">{connectError}</div>
            </div>
            <button onClick={() => setConnectError(null)} className="flex-shrink-0 opacity-60 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {!hubId ? (
          <a
            href="/api/auth/hubspot/start"
            className="inline-flex items-center gap-2 px-5 py-3 rounded-md text-sm font-medium"
            style={{ backgroundColor: "#C8512A", color: "#FFFFFF" }}
          >
            <Link2 className="w-4 h-4" />
            Connect HubSpot portal
          </a>
        ) : (
          <>
            <div className="mb-8 p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#E8EDE1", color: "#5A7048" }}>
              <Check className="w-5 h-5 flex-shrink-0 mt-0.5" />
              <div className="text-sm">
                Connected to portal{" "}
                <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 500 }}>{hubId}</span>
              </div>
            </div>

            {/* Theme path input */}
            <div className="mb-2 flex items-center justify-between">
              <label className="text-sm font-medium" style={{ color: "#1A1814" }}>
                Target theme path
              </label>
              <button
                onClick={() => setShowHelp(!showHelp)}
                className="flex items-center gap-1 text-xs"
                style={{ color: "#5C574E" }}
              >
                <Info className="w-3.5 h-3.5" />
                How do I find this?
              </button>
            </div>
            <p className="text-xs mb-3" style={{ color: "#5C574E", lineHeight: 1.6 }}>
              Paste the folder path to your theme from HubSpot's Design Manager.
            </p>

            {showHelp && (
              <div className="mb-3 p-3 rounded text-xs leading-relaxed" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#5C574E" }}>
                <div className="mb-2" style={{ color: "#1A1814", fontWeight: 500 }}>Finding your theme path</div>
                <ol className="space-y-1 list-decimal list-inside">
                  <li>Open HubSpot → Marketing → Files and Templates → Design Tools</li>
                  <li>Find your theme folder in the left sidebar</li>
                  <li>Right-click the folder → "Copy path" (or read the breadcrumb at the top)</li>
                </ol>
                <div className="mt-3 pt-3" style={{ borderTop: "1px dashed #E8E2D6" }}>
                  <div style={{ color: "#1A1814", fontWeight: 500, marginBottom: 4 }}>Examples</div>
                  <div style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>
                    Focus-child<br />
                    @marketplace/Helpful_Hero/Clean_Pro_Theme<br />
                    MyCustomTheme
                  </div>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <input
                value={themePath}
                onChange={(e) => setThemePath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); validate(); } }}
                placeholder="@marketplace/Publisher/Theme_Name or your-child-theme"
                className="flex-1 px-3 py-2.5 rounded-md outline-none"
                style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#1A1814", fontFamily: "ui-monospace, monospace", fontSize: 13 }}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
              />
              <button
                onClick={validate}
                disabled={validation.status === "validating" || themePath.trim().length === 0}
                className="px-4 py-2.5 rounded-md text-sm font-medium inline-flex items-center gap-2"
                style={{
                  backgroundColor: "#1A1814", color: "#FAF7F2",
                  opacity: validation.status === "validating" || themePath.trim().length === 0 ? 0.5 : 1,
                  cursor: validation.status === "validating" || themePath.trim().length === 0 ? "not-allowed" : "pointer",
                }}
              >
                {validation.status === "validating" ? <><Loader2 className="w-4 h-4 animate-spin" />Validating</> : <>Validate<ArrowRight className="w-4 h-4" /></>}
              </button>
            </div>

            {/* Validation result */}
            {validation.status === "success" && (
              <SafeRender fallback={<DisplayError text="Theme metadata could not be displayed." />}>
                <SuccessCard data={validation.data} />
              </SafeRender>
            )}

            {validation.status === "error" && (
              <DisplayError
                text={safeString(validation.error.error) ?? "Something went wrong."}
                hint={safeString(validation.error.hint) ?? undefined}
              />
            )}

            {/* Index modules action — appears after successful validation */}
            {validation.status === "success" && indexState.status === "idle" && (
              <div className="mt-6 flex items-center justify-between p-4 rounded" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
                <div>
                  <div className="text-sm font-medium" style={{ color: "#1A1814" }}>
                    Catalog this theme's modules
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: "#5C574E" }}>
                    Walks <span style={{ fontFamily: "ui-monospace, monospace" }}>{validation.data.path}/modules</span> and indexes each module's fields.
                  </div>
                </div>
                <button
                  onClick={indexModules}
                  className="px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2 flex-shrink-0"
                  style={{ backgroundColor: "#C8512A", color: "#FFFFFF" }}
                >
                  <Layers className="w-4 h-4" />
                  Index modules
                </button>
              </div>
            )}

            {indexState.status === "indexing" && (
              <div className="mt-6 p-4 rounded flex items-center gap-3" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
                <Loader2 className="w-5 h-5 animate-spin" style={{ color: "#C8512A" }} />
                <div className="text-sm" style={{ color: "#5C574E" }}>
                  Scanning modules folder and reading each module's fields…
                </div>
              </div>
            )}

            {indexState.status === "error" && (
              <DisplayError text={indexState.error} />
            )}

            {indexState.status === "success" && (
              <SafeRender fallback={<DisplayError text="The catalog could not be displayed." />}>
                <ModuleCatalog
                  data={indexState.data}
                  onReindex={indexModules}
                />
              </SafeRender>
            )}
          </>
        )}
      </div>
    </main>
  );
}

// ============================================================
// Validation success card (unchanged from previous milestone)
// ============================================================

function SuccessCard({ data }: { data: Validated }) {
  const label = safeString(data.label) ?? "Theme";
  const author = safeString(data.author);
  const version = safeString(data.version);
  const description = safeString(data.description);
  const path = safeString(data.path) ?? "";

  return (
    <div className="mt-4 p-4 rounded" style={{ backgroundColor: "#FFFFFF", border: "1px solid #B8D0A8" }}>
      <div className="flex items-start gap-3">
        <div className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5" style={{ backgroundColor: "#5A7048" }}>
          <Check className="w-3.5 h-3.5" strokeWidth={2.5} style={{ color: "#FAF7F2" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-base" style={{ color: "#1A1814" }}>{label}</span>
            <SourceBadge source={data.source} />
            {version && (
              <span className="text-xs" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>v{version}</span>
            )}
          </div>
          {author && <div className="text-sm mt-0.5" style={{ color: "#5C574E" }}>by {author}</div>}
          {description && <div className="text-sm mt-2" style={{ color: "#5C574E", lineHeight: 1.5 }}>{description}</div>}
          <div className="text-xs mt-3 pt-3 break-all" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace", borderTop: "1px dashed #E8E2D6" }}>
            {path}
          </div>
        </div>
      </div>
    </div>
  );
}

function SourceBadge({ source }: { source: "marketplace" | "nested" | "custom" }) {
  const config = {
    marketplace: { label: "Marketplace", bg: "#F5EAD1", fg: "#B8822A" },
    custom: { label: "Custom", bg: "#F4E4DA", fg: "#C8512A" },
    nested: { label: "Nested", bg: "#E8EDE1", fg: "#5A7048" },
  }[source];
  return (
    <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: config.bg, color: config.fg, fontFamily: "ui-monospace, monospace" }}>
      {config.label}
    </span>
  );
}

function DisplayError({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="mt-4 p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
      <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
      <div>
        <div className="text-sm font-medium">{text}</div>
        {hint && <div className="text-sm mt-1 opacity-80">{hint}</div>}
      </div>
    </div>
  );
}

// ============================================================
// Module catalog — searchable, filterable list of indexed modules
// ============================================================

const STRUCTURAL_TAG_LABELS: Record<StructuralTag, string> = {
  hero: "Hero",
  accordion: "Accordion",
  tabs: "Tabs",
  "card-grid": "Card grid",
  "feature-list": "Feature list",
  "cta-banner": "CTA banner",
  testimonial: "Testimonial",
  "logo-strip": "Logo strip",
  stats: "Stats",
  gallery: "Gallery",
  form: "Form",
  "rich-text": "Rich text",
  menu: "Menu",
  "blog-listing": "Blog listing",
  unknown: "Other",
};

function ModuleCatalog({ data, onReindex }: { data: IndexResult; onReindex: () => void }) {
  const [query, setQuery] = useState("");
  const [activeTag, setActiveTag] = useState<StructuralTag | null>(null);

  const modules = Array.isArray(data.modules) ? data.modules : [];

  // Compute available tag counts for the filter sidebar
  const tagCounts = useMemo(() => {
    const counts = new Map<StructuralTag, number>();
    for (const m of modules) {
      const seen = new Set<StructuralTag>();
      for (const t of m.tags ?? []) {
        if (seen.has(t)) continue;
        seen.add(t);
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    return counts;
  }, [modules]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return modules.filter((m) => {
      if (activeTag && !m.tags.includes(activeTag)) return false;
      if (q.length === 0) return true;
      const haystack = `${m.name} ${m.label} ${m.description ?? ""} ${(m.metaTags ?? []).join(" ")}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [modules, query, activeTag]);

  const tagKeys = Array.from(tagCounts.keys()).sort((a, b) => {
    // "unknown" always at the bottom
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return (tagCounts.get(b) ?? 0) - (tagCounts.get(a) ?? 0);
  });

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-xl font-medium" style={{ color: "#1A1814", letterSpacing: "-0.01em" }}>
            Module catalog
          </h2>
          <div className="text-xs mt-0.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
            {data.moduleCount} module{data.moduleCount === 1 ? "" : "s"}
            {data.cached && " · cached"}
          </div>
        </div>
        <button
          onClick={onReindex}
          className="text-xs inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md"
          style={{ color: "#5C574E", border: "1px solid #E8E2D6", backgroundColor: "#FFFFFF" }}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Re-index
        </button>
      </div>

      {Array.isArray(data.warnings) && data.warnings.length > 0 && (
        <div className="mb-4 p-3 rounded text-xs" style={{ backgroundColor: "#F5EAD1", color: "#B8822A" }}>
          {data.warnings.map((w, i) => (
            <div key={i}>{safeString(w)}</div>
          ))}
        </div>
      )}

      {/* Search bar */}
      <div className="relative mb-3">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#8B8478" }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search modules by name, tag, or description"
          className="w-full pl-9 pr-3 py-2 rounded-md outline-none"
          style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#1A1814", fontSize: 13 }}
        />
      </div>

      {/* Tag filter pills */}
      {tagKeys.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          <FilterPill
            label="All"
            count={modules.length}
            active={activeTag === null}
            onClick={() => setActiveTag(null)}
          />
          {tagKeys.map((tag) => (
            <FilterPill
              key={tag}
              label={STRUCTURAL_TAG_LABELS[tag]}
              count={tagCounts.get(tag) ?? 0}
              active={activeTag === tag}
              onClick={() => setActiveTag(activeTag === tag ? null : tag)}
            />
          ))}
        </div>
      )}

      {/* Module list */}
      {filtered.length === 0 ? (
        <div className="p-6 text-center rounded" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#5C574E" }}>
          <div className="text-sm">No modules match your filters.</div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => <ModuleRow key={m.path} module={m} />)}
        </div>
      )}
    </div>
  );
}

function FilterPill({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 py-1 rounded-full text-xs inline-flex items-center gap-1.5"
      style={{
        backgroundColor: active ? "#1A1814" : "#FFFFFF",
        color: active ? "#FAF7F2" : "#5C574E",
        border: `1px solid ${active ? "#1A1814" : "#E8E2D6"}`,
      }}
    >
      {label}
      <span className="text-[10px]" style={{ color: active ? "#FAF7F2" : "#8B8478", fontFamily: "ui-monospace, monospace", opacity: 0.7 }}>
        {count}
      </span>
    </button>
  );
}

function ModuleRow({ module: m }: { module: ModuleEntry }) {
  const [expanded, setExpanded] = useState(false);
  const label = safeString(m.label) ?? m.name;
  const description = safeString(m.description);
  const visibleTags = (m.tags ?? []).filter((t) => t !== "unknown");

  return (
    <div
      className="rounded transition-all"
      style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-3 flex items-start gap-3"
      >
        <div className="w-8 h-8 rounded flex items-center justify-center flex-shrink-0" style={{ backgroundColor: "#FAF7F2" }}>
          <ComponentIcon className="w-4 h-4" style={{ color: "#5C574E" }} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-medium text-sm" style={{ color: "#1A1814" }}>{label}</span>
            <span className="text-xs" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>{m.name}</span>
            {m.hasRepeater && <RepeaterBadge />}
          </div>
          {description ? (
            <div className="text-xs mt-1" style={{ color: "#5C574E", lineHeight: 1.5 }}>
              {description.length > 140 ? description.slice(0, 140) + "…" : description}
            </div>
          ) : (
            <div className="text-xs mt-1" style={{ color: "#8B8478" }}>
              {m.totalFields} field{m.totalFields === 1 ? "" : "s"}
            </div>
          )}
          {visibleTags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {visibleTags.map((t) => (
                <span key={t} className="text-[10px] px-1.5 py-0.5 rounded" style={{ backgroundColor: "#F0EADD", color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
                  {STRUCTURAL_TAG_LABELS[t]}
                </span>
              ))}
            </div>
          )}
        </div>
      </button>
      {expanded && <ModuleDetails module={m} />}
    </div>
  );
}

function ModuleDetails({ module: m }: { module: ModuleEntry }) {
  return (
    <div className="px-3 pb-3 pt-0">
      <div className="pt-3" style={{ borderTop: "1px dashed #E8E2D6" }}>
        <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
          Field summary
        </div>
        {m.fields.length === 0 ? (
          <div className="text-xs" style={{ color: "#8B8478" }}>No fields detected.</div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {m.fields.map((f) => <FieldChip key={f.category} field={f} />)}
          </div>
        )}
        <div className="mt-3 text-[10px] uppercase tracking-wider" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
          Path
        </div>
        <div className="text-xs break-all mt-1" style={{ color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
          {m.path}
        </div>
        {Array.isArray(m.warnings) && m.warnings.length > 0 && (
          <div className="mt-3 text-xs" style={{ color: "#B8822A" }}>
            {m.warnings.map((w, i) => <div key={i}>⚠ {safeString(w)}</div>)}
          </div>
        )}
      </div>
    </div>
  );
}

function FieldChip({ field }: { field: FieldSummary }) {
  const config: Record<FieldCategory, { Icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; bg: string; fg: string; label: string }> = {
    text: { Icon: Type, bg: "#F0EADD", fg: "#5C574E", label: "Text" },
    image: { Icon: ImageIcon, bg: "#F5EAD1", fg: "#B8822A", label: "Image" },
    link: { Icon: MousePointer2, bg: "#F4E4DA", fg: "#C8512A", label: "Link/CTA" },
    choice: { Icon: CheckSquare, bg: "#E8EDE1", fg: "#5A7048", label: "Choice" },
    color: { Icon: Palette, bg: "#F2DED8", fg: "#9C3D2B", label: "Color" },
    number: { Icon: Hash, bg: "#F0EADD", fg: "#5C574E", label: "Number" },
    icon: { Icon: Sparkles, bg: "#F0EADD", fg: "#5C574E", label: "Icon" },
    embed: { Icon: Film, bg: "#F0EADD", fg: "#5C574E", label: "Video/embed" },
    repeater: { Icon: Repeat, bg: "#F4E4DA", fg: "#C8512A", label: "Repeater" },
    group: { Icon: Layers, bg: "#F0EADD", fg: "#5C574E", label: "Group" },
    other: { Icon: ComponentIcon, bg: "#F0EADD", fg: "#5C574E", label: "Other" },
  };
  const c = config[field.category];
  return (
    <div className="px-2 py-1.5 rounded inline-flex items-center gap-1.5 text-xs" style={{ backgroundColor: c.bg, color: c.fg }}>
      <c.Icon className="w-3 h-3" />
      <span style={{ fontWeight: 500 }}>{c.label}</span>
      <span style={{ fontFamily: "ui-monospace, monospace", opacity: 0.7, fontSize: 10 }}>×{field.count}</span>
    </div>
  );
}

function RepeaterBadge() {
  return (
    <span className="text-[10px] inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: "#F4E4DA", color: "#C8512A", fontFamily: "ui-monospace, monospace" }}>
      <Repeat className="w-2.5 h-2.5" />
      repeater
    </span>
  );
}