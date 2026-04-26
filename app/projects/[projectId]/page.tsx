/**
 * Single project view.
 *
 * Shows project header (name, theme, portal) and a list of pages with their
 * statuses, titles, and URLs. "Add page" lets the user paste a URL — the
 * server parses it inline and the row updates with the result.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  Plus, ArrowRight, ArrowLeft, Loader2, AlertCircle, ExternalLink, X,
} from "lucide-react";

type Project = {
  id: string;
  hub_id: number;
  theme_path: string;
  theme_label: string | null;
  name: string;
};

type Page = {
  id: string;
  source_url: string;
  page_title: string | null;
  page_description: string | null;
  status: string;
  status_message: string | null;
  section_count: number;
  hubspot_page_url: string | null;
  updated_at: string;
};

type LoadState =
  | { status: "loading" }
  | { status: "ready"; project: Project; pages: Page[] }
  | { status: "error"; message: string };

export default function ProjectPage() {
  const params = useParams<{ projectId: string }>();
  const projectId = params.projectId;

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}`);
      const data = await res.json();
      if (data.ok) setState({ status: "ready", project: data.project, pages: data.pages ?? [] });
      else setState({ status: "error", message: data.error ?? "Failed to load" });
    } catch {
      setState({ status: "error", message: "Couldn't reach the server" });
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  return (
    <main className="min-h-screen py-16 px-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-4xl mx-auto">
        <div className="mb-6">
          <Link href="/projects" className="text-xs inline-flex items-center gap-1 mb-3" style={{ color: "#8B8478" }}>
            <ArrowLeft className="w-3 h-3" /> All projects
          </Link>
        </div>

        {state.status === "loading" && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "#8B8478" }}>
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading…
          </div>
        )}

        {state.status === "error" && (
          <div className="p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div className="text-sm">{state.message}</div>
          </div>
        )}

        {state.status === "ready" && (
          <>
            <div className="mb-8">
              <h1 className="text-3xl font-medium" style={{ color: "#1A1814", letterSpacing: "-0.02em" }}>
                {state.project.name}
              </h1>
              <div className="text-sm mt-2" style={{ color: "#5C574E" }}>
                Portal{" "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>{state.project.hub_id}</span>
                {" · Theme "}
                <span style={{ fontFamily: "ui-monospace, monospace" }}>
                  {state.project.theme_label ?? state.project.theme_path}
                </span>
              </div>
            </div>

            <div className="flex items-end justify-between mb-4">
              <h2 className="text-lg font-medium" style={{ color: "#1A1814" }}>
                Pages ({state.pages.length})
              </h2>
              <button
                onClick={() => setShowAdd(true)}
                className="px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2"
                style={{ backgroundColor: "#C8512A", color: "#FFFFFF" }}
              >
                <Plus className="w-4 h-4" />
                Add page
              </button>
            </div>

            {showAdd && (
              <AddPagePanel
                projectId={projectId}
                onAdded={() => { setShowAdd(false); load(); }}
                onCancel={() => setShowAdd(false)}
              />
            )}

            {!showAdd && state.pages.length === 0 && (
              <div className="p-8 rounded text-center" style={{ backgroundColor: "#FFFFFF", border: "1px dashed #E8E2D6" }}>
                <p className="text-sm" style={{ color: "#5C574E" }}>
                  No pages in this project yet. Add one to get started.
                </p>
              </div>
            )}

            {state.pages.length > 0 && (
              <div className="space-y-2">
                {state.pages.map((p) => (
                  <PageRow key={p.id} projectId={projectId} page={p} />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function PageRow({ projectId, page }: { projectId: string; page: Page }) {
  const title = page.page_title ?? new URL(page.source_url).pathname;

  return (
    <Link
      href={`/projects/${projectId}/pages/${page.id}`}
      className="block p-4 rounded transition-all"
      style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm" style={{ color: "#1A1814" }}>
            {title}
          </div>
          {page.page_description && (
            <div className="text-xs mt-1 line-clamp-1" style={{ color: "#5C574E" }}>
              {page.page_description}
            </div>
          )}
          <div className="text-xs mt-1.5 break-all" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
            {page.source_url}
          </div>
          <div className="flex items-center gap-3 mt-2">
            <StatusChip status={page.status} />
            {page.section_count > 0 && (
              <span className="text-[10px]" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
                {page.section_count} section{page.section_count === 1 ? "" : "s"}
              </span>
            )}
            {page.status_message && (
              <span className="text-[10px]" style={{ color: "#9C3D2B" }}>
                {page.status_message}
              </span>
            )}
          </div>
        </div>
        <ArrowRight className="w-4 h-4 flex-shrink-0 mt-1" style={{ color: "#8B8478" }} />
      </div>
    </Link>
  );
}

export function StatusChip({ status }: { status: string }) {
  const config: Record<string, { bg: string; fg: string; label: string }> = {
    draft:       { bg: "#F0EADD", fg: "#5C574E", label: "Draft" },
    parsing:     { bg: "#F5EAD1", fg: "#B8822A", label: "Parsing…" },
    parsed:      { bg: "#E8EDE1", fg: "#5A7048", label: "Parsed" },
    classifying: { bg: "#F5EAD1", fg: "#B8822A", label: "Classifying…" },
    classified:  { bg: "#E8EDE1", fg: "#5A7048", label: "Classified" },
    matching:    { bg: "#F5EAD1", fg: "#B8822A", label: "Matching…" },
    matched:     { bg: "#E8EDE1", fg: "#5A7048", label: "Matched" },
    publishing:  { bg: "#F5EAD1", fg: "#B8822A", label: "Publishing…" },
    published:   { bg: "#E8EDE1", fg: "#5A7048", label: "Published" },
    error:       { bg: "#F2DED8", fg: "#9C3D2B", label: "Error" },
    archived:    { bg: "#F0EADD", fg: "#8B8478", label: "Archived" },
  };
  const c = config[status] ?? { bg: "#F0EADD", fg: "#5C574E", label: status };
  return (
    <span
      className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded-full"
      style={{ backgroundColor: c.bg, color: c.fg, fontFamily: "ui-monospace, monospace" }}
    >
      {c.label}
    </span>
  );
}

// ============================================================
// Add page panel
// ============================================================

function AddPagePanel({
  projectId, onAdded, onCancel,
}: { projectId: string; onAdded: () => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!url.trim()) return;
    setError(null);
    setAdding(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/pages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      if (data.ok) onAdded();
      else setError(data.error ?? "Couldn't add page");
    } catch {
      setError("Couldn't reach the server");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="mb-4 p-4 rounded" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-medium" style={{ color: "#1A1814" }}>Add page</div>
        <button onClick={onCancel} style={{ color: "#8B8478" }}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex gap-2">
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); add(); } }}
          placeholder="https://example.com/your-page"
          className="flex-1 px-3 py-2 rounded-md outline-none"
          style={{ backgroundColor: "#FAF7F2", border: "1px solid #E8E2D6", color: "#1A1814", fontFamily: "ui-monospace, monospace", fontSize: 13 }}
          autoFocus
        />
        <button
          onClick={add}
          disabled={adding || url.trim().length === 0}
          className="px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2"
          style={{ backgroundColor: "#1A1814", color: "#FAF7F2", opacity: adding || !url.trim() ? 0.5 : 1 }}
        >
          {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Add and parse
        </button>
      </div>

      <p className="text-xs mt-2" style={{ color: "#8B8478" }}>
        Parsing takes 5-15 seconds. The page is added immediately and updates as parsing completes.
      </p>

      {error && <div className="mt-3 text-xs" style={{ color: "#9C3D2B" }}>{error}</div>}
    </div>
  );
}