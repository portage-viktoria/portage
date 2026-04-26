/**
 * Single page view inside a project.
 *
 * Shows: page metadata header, status, section list. Provides a "Classify
 * with AI" action when status is parsed; once classified, each section shows
 * its inferred type and confidence next to it.
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft, Loader2, AlertCircle, Sparkles, ChevronDown, ChevronRight,
  Type, Image as ImageIcon, Link as LinkIcon,
} from "lucide-react";

type ParsedSection = {
  id: string;
  content: {
    heading?: string;
    text: string;
    headings: Array<{ level: number; text: string }>;
    images: Array<{ src: string; alt?: string }>;
    links: Array<{ text: string; href: string }>;
    wordCount: number;
  };
  domPath: string;
};

type Classification = {
  id: string;
  type: string;
  confidence: number;
  reasoning?: string;
};

type Page = {
  id: string;
  source_url: string;
  page_title: string | null;
  page_description: string | null;
  status: string;
  status_message: string | null;
  section_count: number;
  parsed_json: { sections?: ParsedSection[] } | null;
  classifications_json: { sections?: Classification[] } | null;
  full_screenshot_url: string | null;
};

type Project = { id: string; name: string };

type LoadState =
  | { status: "loading" }
  | { status: "ready"; page: Page; project?: Project }
  | { status: "error"; message: string };

export default function PageWorkflowPage() {
  const params = useParams<{ projectId: string; pageId: string }>();
  const { projectId, pageId } = params;

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [classifying, setClassifying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [pageRes, projectRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/pages/${pageId}`),
        fetch(`/api/projects/${projectId}`),
      ]);
      const pageData = await pageRes.json();
      const projectData = await projectRes.json();
      if (pageData.ok) {
        setState({
          status: "ready",
          page: pageData.page,
          project: projectData.ok ? projectData.project : undefined,
        });
      } else {
        setState({ status: "error", message: pageData.error ?? "Failed to load" });
      }
    } catch {
      setState({ status: "error", message: "Couldn't reach the server" });
    }
  }, [projectId, pageId]);

  useEffect(() => { load(); }, [load]);

  async function classify() {
    setActionError(null);
    setClassifying(true);
    try {
      const res = await fetch(
        `/api/projects/${projectId}/pages/${pageId}/classify`,
        { method: "POST" }
      );
      const data = await res.json();
      if (data.ok) await load();
      else setActionError(data.error ?? "Classification failed");
    } catch {
      setActionError("Couldn't reach the server");
    } finally {
      setClassifying(false);
    }
  }

  return (
    <main className="min-h-screen py-16 px-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-4xl mx-auto">
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
          <PageContent
            page={state.page}
            projectId={projectId}
            project={state.project}
            classifying={classifying}
            actionError={actionError}
            onClassify={classify}
          />
        )}
      </div>
    </main>
  );
}

function PageContent({
  page, projectId, project, classifying, actionError, onClassify,
}: {
  page: Page;
  projectId: string;
  project?: Project;
  classifying: boolean;
  actionError: string | null;
  onClassify: () => void;
}) {
  const sections = page.parsed_json?.sections ?? [];
  const classifications = page.classifications_json?.sections ?? [];

  const classificationById = new Map<string, Classification>(
    classifications.map((c) => [c.id, c])
  );

  const showClassifyButton = page.status === "parsed" || page.status === "classified";

  return (
    <>
      <div className="mb-6">
        <Link
          href={`/projects/${projectId}`}
          className="text-xs inline-flex items-center gap-1 mb-3"
          style={{ color: "#8B8478" }}
        >
          <ArrowLeft className="w-3 h-3" /> {project?.name ?? "Project"}
        </Link>
      </div>

      <div className="mb-8">
        {page.page_title && (
          <h1 className="text-2xl font-medium" style={{ color: "#1A1814", letterSpacing: "-0.02em" }}>
            {page.page_title}
          </h1>
        )}
        {page.page_description && (
          <p className="text-sm mt-2" style={{ color: "#5C574E" }}>
            {page.page_description}
          </p>
        )}
        <div className="text-xs mt-3 break-all" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
          {page.source_url}
        </div>
        <div className="mt-3">
          <StatusChip status={page.status} />
          {page.status_message && (
            <span className="ml-2 text-xs" style={{ color: "#9C3D2B" }}>{page.status_message}</span>
          )}
        </div>
      </div>

      {showClassifyButton && (
        <div className="mb-6 p-4 rounded flex items-center justify-between" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
          <div>
            <div className="text-sm font-medium" style={{ color: "#1A1814" }}>
              {page.status === "classified" ? "Re-classify with AI" : "Classify sections with AI"}
            </div>
            <div className="text-xs mt-0.5" style={{ color: "#5C574E" }}>
              Claude reads each section and labels its structural type. Costs ~$0.01-0.05 per page.
            </div>
          </div>
          <button
            onClick={onClassify}
            disabled={classifying}
            className="px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2"
            style={{ backgroundColor: "#C8512A", color: "#FFFFFF", opacity: classifying ? 0.6 : 1 }}
          >
            {classifying ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {page.status === "classified" ? "Re-classify" : "Classify"}
          </button>
        </div>
      )}

      {actionError && (
        <div className="mb-4 p-3 rounded text-sm flex items-start gap-2" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{actionError}</div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
        {page.full_screenshot_url && (
          <div className="hidden md:block">
            <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              Full page
            </div>
            <a href={page.full_screenshot_url} target="_blank" rel="noreferrer">
              <img src={page.full_screenshot_url} alt="" className="rounded w-full" style={{ border: "1px solid #E8E2D6" }} />
            </a>
          </div>
        )}
        <div className="space-y-2">
          {sections.length === 0 ? (
            <div className="p-6 text-center rounded text-sm" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#5C574E" }}>
              No sections.
            </div>
          ) : (
            sections.map((s) => (
              <SectionRow
                key={s.id}
                section={s}
                classification={classificationById.get(s.id)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}

// Reuse status chip styles from project view
function StatusChip({ status }: { status: string }) {
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

function ConfidenceChip({ confidence }: { confidence: number }) {
  let bg, fg;
  if (confidence >= 0.85) { bg = "#E8EDE1"; fg = "#5A7048"; }
  else if (confidence >= 0.7) { bg = "#F5EAD1"; fg = "#B8822A"; }
  else { bg = "#F2DED8"; fg = "#9C3D2B"; }
  return (
    <span
      className="text-[10px] font-medium px-1.5 py-0.5 rounded"
      style={{ backgroundColor: bg, color: fg, fontFamily: "ui-monospace, monospace" }}
    >
      {Math.round(confidence * 100)}%
    </span>
  );
}

function SectionRow({ section, classification }: { section: ParsedSection; classification?: Classification }) {
  const [expanded, setExpanded] = useState(false);
  const heading = section.content?.heading;
  const text = section.content?.text ?? "";
  const preview = text.length > 180 ? text.slice(0, 180) + "…" : text;
  const wordCount = section.content?.wordCount ?? 0;
  const imageCount = section.content?.images?.length ?? 0;
  const linkCount = section.content?.links?.length ?? 0;

  return (
    <div className="rounded transition-all" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left p-3 flex items-start gap-3">
        <div className="flex-shrink-0">
          {expanded ? <ChevronDown className="w-4 h-4 mt-1" style={{ color: "#8B8478" }} /> : <ChevronRight className="w-4 h-4 mt-1" style={{ color: "#8B8478" }} />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[10px] font-medium uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ backgroundColor: "#F0EADD", color: "#5C574E", fontFamily: "ui-monospace, monospace" }}>
              {section.id}
            </span>
            {classification && (
              <>
                <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded" style={{ backgroundColor: "#F4E4DA", color: "#C8512A", fontFamily: "ui-monospace, monospace" }}>
                  {classification.type}
                </span>
                <ConfidenceChip confidence={classification.confidence} />
              </>
            )}
            {heading && <span className="font-medium text-sm" style={{ color: "#1A1814" }}>{heading}</span>}
          </div>
          <div className="text-xs mt-1" style={{ color: "#5C574E", lineHeight: 1.5 }}>
            {preview || <span style={{ color: "#8B8478", fontStyle: "italic" }}>No text</span>}
          </div>
          {classification?.reasoning && (
            <div className="text-xs mt-2 italic" style={{ color: "#8B8478" }}>
              <Sparkles className="w-3 h-3 inline mr-1" />
              {classification.reasoning}
            </div>
          )}
          <div className="flex items-center gap-3 mt-2">
            <span className="text-[10px] inline-flex items-center gap-1" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
              <Type className="w-2.5 h-2.5" /> {wordCount}w
            </span>
            {imageCount > 0 && (
              <span className="text-[10px] inline-flex items-center gap-1" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
                <ImageIcon className="w-2.5 h-2.5" /> {imageCount}
              </span>
            )}
            {linkCount > 0 && (
              <span className="text-[10px] inline-flex items-center gap-1" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
                <LinkIcon className="w-2.5 h-2.5" /> {linkCount}
              </span>
            )}
          </div>
        </div>
      </button>
      {expanded && section.content?.text && (
        <div className="px-3 pb-3 pt-0">
          <div className="pt-3" style={{ borderTop: "1px dashed #E8E2D6" }}>
            <div className="text-xs whitespace-pre-wrap" style={{ color: "#5C574E", lineHeight: 1.6, maxHeight: 200, overflow: "auto" }}>
              {section.content.text}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}