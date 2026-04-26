/**
 * Source page parser UI.
 *
 * Standalone page for now — paste a URL, see the page parsed into sections.
 * Once the full migration flow is built, this becomes the first step.
 */

"use client";

import { useEffect, useState, Component, ReactNode } from "react";
import {
  Globe,
  ArrowRight,
  Loader2,
  AlertCircle,
  ChevronRight,
  ChevronDown,
  Image as ImageIcon,
  Type,
  Link as LinkIcon,
  RefreshCw,
} from "lucide-react";

// ============================================================
// Types — must match what the API returns
// ============================================================

type ExtractedImage = { src: string; alt?: string; width?: number; height?: number };
type ExtractedLink = { text: string; href: string };
type SectionContent = {
  text: string;
  heading?: string;
  headings: Array<{ level: number; text: string }>;
  images: ExtractedImage[];
  links: ExtractedLink[];
  wordCount: number;
};
type DetectedSection = {
  id: string;
  html: string;
  content: SectionContent;
  domPath: string;
  approximateOrder: number;
};
type ParsedPage = {
  ok: true;
  sourceUrl: string;
  pageTitle?: string;
  pageDescription?: string;
  sections: DetectedSection[];
  sectionCount: number;
  warnings: string[];
  parsedAt: string;
  fullScreenshotUrl?: string;
  cached?: boolean;
};

type ParseState =
  | { status: "idle" }
  | { status: "parsing" }
  | { status: "success"; data: ParsedPage }
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

export default function SourcePage() {
  const [url, setUrl] = useState("https://www.bluleadz.com/preferred-partners");
  const [state, setState] = useState<ParseState>({ status: "idle" });

  // Try loading cached parse on URL change
  useEffect(() => {
    if (!url || state.status !== "idle") return;
    fetch(`/api/sources/parse?url=${encodeURIComponent(url)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && data.ok) setState({ status: "success", data });
      })
      .catch(() => { /* silent */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function parseNow() {
    if (!url.trim()) return;
    setState({ status: "parsing" });
    try {
      const res = await fetch("/api/sources/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data && data.ok) setState({ status: "success", data });
      else setState({ status: "error", error: safeString(data?.error) ?? "Parsing failed." });
    } catch {
      setState({ status: "error", error: "Couldn't reach the server." });
    }
  }

  return (
    <main className="min-h-screen py-16 px-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-4xl mx-auto">
        <div className="mb-10">
          <div
            className="inline-flex items-center gap-2 mb-4"
            style={{ color: "#C8512A", fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.1em" }}
          >
            <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ backgroundColor: "#1A1814" }}>
              <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: "#C8512A" }} />
            </div>
            <span className="uppercase">Portage · source parser</span>
          </div>
          <h1 className="text-3xl font-medium" style={{ color: "#1A1814", letterSpacing: "-0.02em" }}>
            Paste a URL. Portage breaks it into sections.
          </h1>
          <p className="text-sm mt-3 max-w-xl" style={{ color: "#5C574E", lineHeight: 1.6 }}>
            We render the page with a real browser, walk its DOM, detect logical sections, and extract
            the content from each one — text, headings, images, links.
          </p>
        </div>

        <div className="flex gap-2 mb-2">
          <div className="flex-1 relative">
            <Globe className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: "#8B8478" }} />
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); parseNow(); } }}
              placeholder="https://example.com/your-page"
              className="w-full pl-9 pr-3 py-2.5 rounded-md outline-none"
              style={{
                backgroundColor: "#FFFFFF",
                border: "1px solid #E8E2D6",
                color: "#1A1814",
                fontFamily: "ui-monospace, monospace",
                fontSize: 13,
              }}
              spellCheck={false}
            />
          </div>
          <button
            onClick={parseNow}
            disabled={state.status === "parsing" || url.trim().length === 0}
            className="px-4 py-2.5 rounded-md text-sm font-medium inline-flex items-center gap-2"
            style={{
              backgroundColor: "#1A1814",
              color: "#FAF7F2",
              opacity: state.status === "parsing" || url.trim().length === 0 ? 0.5 : 1,
              cursor: state.status === "parsing" || url.trim().length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {state.status === "parsing" ? (
              <><Loader2 className="w-4 h-4 animate-spin" />Parsing</>
            ) : (
              <>Parse<ArrowRight className="w-4 h-4" /></>
            )}
          </button>
        </div>

        <p className="text-xs mb-6" style={{ color: "#8B8478" }}>
          Parsing takes 5-15 seconds — we render the page with a headless browser.
        </p>

        {state.status === "parsing" && (
          <div className="p-6 rounded text-sm flex items-center gap-3" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#5C574E" }}>
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: "#C8512A" }} />
            <div>Rendering with Browserless and walking the DOM…</div>
          </div>
        )}

        {state.status === "error" && (
          <div className="p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="text-sm">{state.error}</div>
          </div>
        )}

        {state.status === "success" && (
          <SafeRender fallback={<div className="p-4 rounded" style={{ backgroundColor: "#F5EAD1", color: "#B8822A" }}>Couldn't display the parse result.</div>}>
            <ParseResult data={state.data} onReparse={parseNow} />
          </SafeRender>
        )}
      </div>
    </main>
  );
}

function ParseResult({ data, onReparse }: { data: ParsedPage; onReparse: () => void }) {
  const sections = Array.isArray(data.sections) ? data.sections : [];
  const title = safeString(data.pageTitle);
  const description = safeString(data.pageDescription);

  return (
    <div>
      <div className="mb-6 p-4 rounded" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {title && (
              <div className="text-base font-medium" style={{ color: "#1A1814" }}>
                {title}
              </div>
            )}
            {description && (
              <div className="text-sm mt-1" style={{ color: "#5C574E" }}>
                {description.length > 160 ? description.slice(0, 160) + "…" : description}
              </div>
            )}
            <div className="text-xs mt-2 break-all" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              {data.sourceUrl}
            </div>
          </div>
          <button
            onClick={onReparse}
            className="text-xs inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md flex-shrink-0"
            style={{ color: "#5C574E", border: "1px solid #E8E2D6", backgroundColor: "#FAF7F2" }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Re-parse
          </button>
        </div>
        <div className="flex items-center gap-4 mt-3 pt-3" style={{ borderTop: "1px dashed #E8E2D6" }}>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "#5A7048" }} />
            <span className="text-xs" style={{ color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
              {data.sectionCount} section{data.sectionCount === 1 ? "" : "s"}
            </span>
          </div>
          {data.cached && (
            <span className="text-xs" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              cached
            </span>
          )}
        </div>
      </div>

      {Array.isArray(data.warnings) && data.warnings.length > 0 && (
        <div className="mb-4 p-3 rounded text-xs" style={{ backgroundColor: "#F5EAD1", color: "#B8822A" }}>
          {data.warnings.map((w, i) => (
            <div key={i}>⚠ {safeString(w)}</div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        {data.fullScreenshotUrl && (
          <div className="hidden md:block">
            <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              Full page
            </div>
            <a href={data.fullScreenshotUrl} target="_blank" rel="noreferrer">
              <img
                src={data.fullScreenshotUrl}
                alt="Full page screenshot"
                className="rounded w-full"
                style={{ border: "1px solid #E8E2D6" }}
              />
            </a>
          </div>
        )}
        <div className="space-y-2">
          {sections.length === 0 ? (
            <div className="p-6 text-center rounded text-sm" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#5C574E" }}>
              No sections detected.
            </div>
          ) : (
            sections.map((s) => <SectionRow key={s.id} section={s} />)
          )}
        </div>
      </div>
    </div>
  );
}

function SectionRow({ section }: { section: DetectedSection }) {
  const [expanded, setExpanded] = useState(false);
  const heading = safeString(section.content?.heading);
  const text = safeString(section.content?.text) ?? "";
  const preview = text.length > 200 ? text.slice(0, 200) + "…" : text;
  const wordCount = section.content?.wordCount ?? 0;
  const imageCount = section.content?.images?.length ?? 0;
  const linkCount = section.content?.links?.length ?? 0;

  return (
    <div className="rounded transition-all" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full text-left p-3 flex items-start gap-3"
      >
        <div className="flex-shrink-0">
          {expanded ? (
            <ChevronDown className="w-4 h-4 mt-1" style={{ color: "#8B8478" }} />
          ) : (
            <ChevronRight className="w-4 h-4 mt-1" style={{ color: "#8B8478" }} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ backgroundColor: "#F0EADD", color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
              {section.id}
            </span>
            {heading && (
              <span className="font-medium text-sm" style={{ color: "#1A1814" }}>
                {heading}
              </span>
            )}
          </div>
          <div className="text-xs mt-1" style={{ color: "#5C574E", lineHeight: 1.5 }}>
            {preview || <span style={{ color: "#8B8478", fontStyle: "italic" }}>No text content</span>}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <span className="text-[10px] inline-flex items-center gap-1" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              <Type className="w-2.5 h-2.5" />
              {wordCount} words
            </span>
            {imageCount > 0 && (
              <span className="text-[10px] inline-flex items-center gap-1" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
                <ImageIcon className="w-2.5 h-2.5" />
                {imageCount} image{imageCount === 1 ? "" : "s"}
              </span>
            )}
            {linkCount > 0 && (
              <span className="text-[10px] inline-flex items-center gap-1" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
                <LinkIcon className="w-2.5 h-2.5" />
                {linkCount} link{linkCount === 1 ? "" : "s"}
              </span>
            )}
          </div>
        </div>
      </button>
      {expanded && <SectionDetails section={section} />}
    </div>
  );
}

function SectionDetails({ section }: { section: DetectedSection }) {
  const headings = section.content?.headings ?? [];
  const images = section.content?.images ?? [];
  const links = section.content?.links ?? [];

  return (
    <div className="px-3 pb-3 pt-0">
      <div className="pt-3 space-y-3" style={{ borderTop: "1px dashed #E8E2D6" }}>
        {section.content?.text && (
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              Extracted text
            </div>
            <div className="text-xs whitespace-pre-wrap" style={{ color: "#5C574E", lineHeight: 1.6, maxHeight: 200, overflow: "auto" }}>
              {section.content.text}
            </div>
          </div>
        )}

        {headings.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              Headings
            </div>
            <div className="space-y-1">
              {headings.map((h, i) => (
                <div key={i} className="text-xs flex items-baseline gap-2">
                  <span className="text-[10px] px-1 rounded" style={{ backgroundColor: "#F0EADD", color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
                    H{h.level}
                  </span>
                  <span style={{ color: "#1A1814" }}>{h.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {images.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              Images ({images.length})
            </div>
            <div className="space-y-1">
              {images.slice(0, 6).map((img, i) => (
                <div key={i} className="text-xs flex items-baseline gap-2">
                  <ImageIcon className="w-3 h-3 flex-shrink-0 mt-0.5" style={{ color: "#8B8478" }} />
                  <span className="break-all" style={{ color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
                    {img.src}
                  </span>
                </div>
              ))}
              {images.length > 6 && (
                <div className="text-xs" style={{ color: "#8B8478" }}>+ {images.length - 6} more</div>
              )}
            </div>
          </div>
        )}

        {links.length > 0 && (
          <div>
            <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              Links ({links.length})
            </div>
            <div className="space-y-1">
              {links.slice(0, 6).map((link, i) => (
                <div key={i} className="text-xs flex items-baseline gap-2">
                  <LinkIcon className="w-3 h-3 flex-shrink-0 mt-0.5" style={{ color: "#8B8478" }} />
                  <div className="min-w-0">
                    <div style={{ color: "#1A1814" }}>{link.text}</div>
                    <div className="break-all" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>{link.href}</div>
                  </div>
                </div>
              ))}
              {links.length > 6 && (
                <div className="text-xs" style={{ color: "#8B8478" }}>+ {links.length - 6} more</div>
              )}
            </div>
          </div>
        )}

        <div>
          <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
            DOM path
          </div>
          <div className="text-xs break-all" style={{ color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
            {section.domPath || <span style={{ color: "#8B8478" }}>—</span>}
          </div>
        </div>
      </div>
    </div>
  );
}