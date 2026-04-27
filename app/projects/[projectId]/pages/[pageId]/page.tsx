/**
 * Single page workflow — milestone 4b update.
 *
 * Adds:
 *   - "Match modules" button after classified
 *   - Per-section match display with module name, confidence, field mappings
 *   - "Publish to HubSpot" button after matched
 *   - Publish dialog with destination radio (Staging / Draft), title/slug fields,
 *     and tier detection for the staging option
 *   - Once published, shows a success card with link to the HubSpot page
 */

"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft, Loader2, AlertCircle, Sparkles, ChevronDown, ChevronRight,
  Type, Image as ImageIcon, Link as LinkIcon, X, Upload, ExternalLink,
  Check, AlertTriangle,
} from "lucide-react";

// ============================================================
// Types
// ============================================================

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

type FieldMapping = {
  fieldName: string;
  fieldType: string;
  source: string;
  value?: string;
  description: string;
};

type SectionMatch = {
  sectionId: string;
  matchedModule: string;
  matchedModulePath: string;
  confidence: number;
  reasoning: string;
  fieldMappings: FieldMapping[];
  isFallback: boolean;
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
  matches_json: { sections?: SectionMatch[] } | null;
  full_screenshot_url: string | null;
  hubspot_page_id: string | null;
  hubspot_page_url: string | null;
};

type Project = { id: string; name: string };

type LoadState =
  | { status: "loading" }
  | { status: "ready"; page: Page; project?: Project }
  | { status: "error"; message: string };

// ============================================================
// Page
// ============================================================

export default function PageWorkflowPage() {
  const params = useParams<{ projectId: string; pageId: string }>();
  const { projectId, pageId } = params;

  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [actionState, setActionState] = useState<
    | { kind: "idle" }
    | { kind: "classifying" }
    | { kind: "matching" }
    | { kind: "publishing" }
  >({ kind: "idle" });
  const [actionError, setActionError] = useState<string | null>(null);
  const [showPublishDialog, setShowPublishDialog] = useState(false);

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
    setActionState({ kind: "classifying" });
    try {
      const res = await fetch(`/api/projects/${projectId}/pages/${pageId}/classify`, { method: "POST" });
      const data = await res.json();
      if (data.ok) await load();
      else setActionError(data.error ?? "Classification failed");
    } catch {
      setActionError("Couldn't reach the server");
    } finally {
      setActionState({ kind: "idle" });
    }
  }

  async function match() {
    setActionError(null);
    setActionState({ kind: "matching" });
    try {
      const res = await fetch(`/api/projects/${projectId}/pages/${pageId}/match`, { method: "POST" });
      const data = await res.json();
      if (data.ok) await load();
      else setActionError(data.error ?? "Matching failed");
    } catch {
      setActionError("Couldn't reach the server");
    } finally {
      setActionState({ kind: "idle" });
    }
  }

  return (
    <main className="min-h-screen py-16 px-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-4xl mx-auto">
        {state.status === "loading" && (
          <div className="flex items-center gap-2 text-sm" style={{ color: "#8B8478" }}>
            <Loader2 className="w-4 h-4 animate-spin" /> Loading…
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
            <PageContent
              page={state.page}
              projectId={projectId}
              project={state.project}
              actionState={actionState}
              actionError={actionError}
              onClassify={classify}
              onMatch={match}
              onPublishClick={() => setShowPublishDialog(true)}
            />

            {showPublishDialog && (
              <PublishDialog
                projectId={projectId}
                pageId={pageId}
                page={state.page}
                onClose={() => setShowPublishDialog(false)}
                onPublished={() => {
                  setShowPublishDialog(false);
                  load();
                }}
              />
            )}
          </>
        )}
      </div>
    </main>
  );
}

// ============================================================
// Main page content
// ============================================================

function PageContent({
  page, projectId, project, actionState, actionError,
  onClassify, onMatch, onPublishClick,
}: {
  page: Page;
  projectId: string;
  project?: Project;
  actionState: { kind: string };
  actionError: string | null;
  onClassify: () => void;
  onMatch: () => void;
  onPublishClick: () => void;
}) {
  const sections = page.parsed_json?.sections ?? [];
  const classifications = page.classifications_json?.sections ?? [];
  const matches = page.matches_json?.sections ?? [];

  const classificationById = new Map(classifications.map((c) => [c.id, c]));
  const matchById = new Map(matches.map((m) => [m.sectionId, m]));

  return (
    <>
      <div className="mb-6">
        <Link href={`/projects/${projectId}`} className="text-xs inline-flex items-center gap-1 mb-3" style={{ color: "#8B8478" }}>
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
          <p className="text-sm mt-2" style={{ color: "#5C574E" }}>{page.page_description}</p>
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

      {/* Published success card */}
      {page.status === "published" && page.hubspot_page_url && (
        <div className="mb-6 p-4 rounded flex items-start gap-3" style={{ backgroundColor: "#E8EDE1", border: "1px solid #B8D0A8" }}>
          <Check className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: "#5A7048" }} />
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium" style={{ color: "#1A1814" }}>
              Published to HubSpot
            </div>
            <a
              href={page.hubspot_page_url}
              target="_blank"
              rel="noreferrer"
              className="text-xs mt-1 inline-flex items-center gap-1 break-all"
              style={{ color: "#5A7048", fontFamily: "ui-monospace, monospace" }}
            >
              {page.hubspot_page_url}
              <ExternalLink className="w-3 h-3 flex-shrink-0" />
            </a>
          </div>
        </div>
      )}

      {/* Action: classify */}
      {(page.status === "parsed" || page.status === "classified") && (
        <ActionCard
          title={page.status === "classified" ? "Re-classify with AI" : "Classify sections with AI"}
          description="Claude reads each section and labels its structural type. Costs ~$0.01-0.05 per page."
          buttonLabel={page.status === "classified" ? "Re-classify" : "Classify"}
          icon={<Sparkles className="w-4 h-4" />}
          loading={actionState.kind === "classifying"}
          onClick={onClassify}
        />
      )}

      {/* Action: match */}
      {(page.status === "classified" || page.status === "matched") && (
        <ActionCard
          title={page.status === "matched" ? "Re-match modules" : "Match to theme modules"}
          description="Claude picks the best module from your theme catalog for each section and maps content to fields. ~$0.10-0.30 per page."
          buttonLabel={page.status === "matched" ? "Re-match" : "Match modules"}
          icon={<Sparkles className="w-4 h-4" />}
          loading={actionState.kind === "matching"}
          onClick={onMatch}
        />
      )}

      {/* Action: publish */}
      {page.status === "matched" && (
        <ActionCard
          title="Publish to HubSpot"
          description="Uploads images to File Manager and creates the page. Choose between content staging (Pro+) and draft (any tier) in the next step."
          buttonLabel="Publish…"
          icon={<Upload className="w-4 h-4" />}
          loading={actionState.kind === "publishing"}
          onClick={onPublishClick}
          variant="primary"
        />
      )}

      {actionError && (
        <div className="mb-4 p-3 rounded text-sm flex items-start gap-2" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>{actionError}</div>
        </div>
      )}

      {/* Sections */}
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
                match={matchById.get(s.id)}
              />
            ))
          )}
        </div>
      </div>
    </>
  );
}

// ============================================================
// Action card
// ============================================================

function ActionCard({
  title, description, buttonLabel, icon, loading, onClick, variant,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  icon: React.ReactNode;
  loading: boolean;
  onClick: () => void;
  variant?: "primary" | "default";
}) {
  return (
    <div className="mb-3 p-4 rounded flex items-center justify-between" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
      <div>
        <div className="text-sm font-medium" style={{ color: "#1A1814" }}>{title}</div>
        <div className="text-xs mt-0.5" style={{ color: "#5C574E", maxWidth: 480 }}>{description}</div>
      </div>
      <button
        onClick={onClick}
        disabled={loading}
        className="px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2"
        style={{
          backgroundColor: variant === "primary" ? "#1A1814" : "#C8512A",
          color: "#FFFFFF",
          opacity: loading ? 0.6 : 1,
        }}
      >
        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : icon}
        {buttonLabel}
      </button>
    </div>
  );
}

// ============================================================
// Status chip + confidence chip
// ============================================================

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

// ============================================================
// Section row with match details
// ============================================================

function SectionRow({
  section, classification, match,
}: { section: ParsedSection; classification?: Classification; match?: SectionMatch }) {
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
            {match && (
              <>
                <span style={{ color: "#8B8478" }}>→</span>
                <span className="text-[10px] font-medium uppercase tracking-wider px-2 py-0.5 rounded" style={{
                  backgroundColor: match.isFallback ? "#F5EAD1" : "#E8EDE1",
                  color: match.isFallback ? "#B8822A" : "#5A7048",
                  fontFamily: "ui-monospace, monospace",
                }}>
                  {match.matchedModule}
                </span>
                <ConfidenceChip confidence={match.confidence} />
              </>
            )}
            {heading && <span className="font-medium text-sm" style={{ color: "#1A1814" }}>{heading}</span>}
          </div>
          <div className="text-xs mt-1" style={{ color: "#5C574E", lineHeight: 1.5 }}>
            {preview || <span style={{ color: "#8B8478", fontStyle: "italic" }}>No text</span>}
          </div>
          {match?.reasoning && (
            <div className="text-xs mt-2 italic" style={{ color: "#8B8478" }}>
              <Sparkles className="w-3 h-3 inline mr-1" />
              {match.reasoning}
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

      {expanded && (
        <div className="px-3 pb-3 pt-0">
          <div className="pt-3 space-y-3" style={{ borderTop: "1px dashed #E8E2D6" }}>
            {section.content?.text && (
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
                  Source text
                </div>
                <div className="text-xs whitespace-pre-wrap" style={{ color: "#5C574E", lineHeight: 1.6, maxHeight: 200, overflow: "auto" }}>
                  {section.content.text}
                </div>
              </div>
            )}

            {match && match.fieldMappings.length > 0 && (
              <div>
                <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: "#8B8478", fontFamily: "ui-monospace, monospace" }}>
                  Field mapping → {match.matchedModule}
                </div>
                <div className="space-y-1">
                  {match.fieldMappings.map((m, i) => (
                    <div key={i} className="text-xs flex items-baseline gap-2">
                      <span style={{ fontFamily: "ui-monospace, monospace", color: "#1A1814" }}>{m.fieldName}</span>
                      <span style={{ color: "#8B8478" }}>←</span>
                      <span style={{ color: "#5C574E" }}>{m.description}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Publish dialog
// ============================================================

function PublishDialog({
  projectId, pageId, page, onClose, onPublished,
}: {
  projectId: string;
  pageId: string;
  page: Page;
  onClose: () => void;
  onPublished: () => void;
}) {
  const [stagingAvailable, setStagingAvailable] = useState<boolean | null>(null);
  const [destination, setDestination] = useState<"STAGING" | "DRAFT">("DRAFT");
  const [pageTitle, setPageTitle] = useState(page.page_title ?? "");
  const [pageSlug, setPageSlug] = useState(deriveSlug(page.source_url));
  const [metaDescription, setMetaDescription] = useState(page.page_description ?? "");
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Probe staging availability when dialog opens
  useEffect(() => {
    fetch(`/api/projects/${projectId}/pages/${pageId}/staging-check`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setStagingAvailable(d.stagingAvailable);
        else setStagingAvailable(false);
      })
      .catch(() => setStagingAvailable(false));
  }, [projectId, pageId]);

  async function publish() {
    setError(null);
    setPublishing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/pages/${pageId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          destination,
          pageTitle: pageTitle.trim() || undefined,
          pageSlug: pageSlug.trim() || undefined,
          metaDescription: metaDescription.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (data.ok) onPublished();
      else setError(data.error ?? "Publish failed");
    } catch {
      setError("Couldn't reach the server");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center p-4 z-50"
      style={{ backgroundColor: "rgba(26, 24, 20, 0.4)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md p-6 rounded"
        style={{ backgroundColor: "#FAF7F2", border: "1px solid #E8E2D6" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-lg font-medium" style={{ color: "#1A1814" }}>
            Publish to HubSpot
          </h3>
          <button onClick={onClose} style={{ color: "#8B8478" }}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-4">
          {/* Destination radio */}
          <div>
            <label className="text-sm font-medium block mb-2" style={{ color: "#1A1814" }}>
              Where should this page land?
            </label>
            <div className="space-y-2">
              <RadioOption
                checked={destination === "STAGING"}
                onClick={() => setDestination("STAGING")}
                disabled={stagingAvailable === false}
                label="Content staging"
                description={
                  stagingAvailable === null
                    ? "Checking availability…"
                    : stagingAvailable
                      ? "Safe sandbox — preview before going live. Pro+ tier."
                      : "Not available on this portal's plan (Starter tier)."
                }
              />
              <RadioOption
                checked={destination === "DRAFT"}
                onClick={() => setDestination("DRAFT")}
                label="Live site as draft"
                description="Created on the live site as an unpublished draft. Works on any tier."
              />
            </div>
          </div>

          <Field label="Page title">
            <input
              value={pageTitle}
              onChange={(e) => setPageTitle(e.target.value)}
              placeholder="Untitled migrated page"
              className="w-full px-3 py-2 rounded-md outline-none"
              style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#1A1814", fontSize: 13 }}
            />
          </Field>

          <Field label="URL slug" hint="The path portion after your domain">
            <input
              value={pageSlug}
              onChange={(e) => setPageSlug(e.target.value)}
              placeholder="page-slug"
              className="w-full px-3 py-2 rounded-md outline-none"
              style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#1A1814", fontFamily: "ui-monospace, monospace", fontSize: 13 }}
            />
          </Field>

          <Field label="Meta description" hint="Optional">
            <textarea
              value={metaDescription}
              onChange={(e) => setMetaDescription(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded-md outline-none resize-none"
              style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6", color: "#1A1814", fontSize: 13 }}
            />
          </Field>

          {error && (
            <div className="p-3 rounded text-xs flex items-start gap-2" style={{ backgroundColor: "#F2DED8", color: "#9C3D2B" }}>
              <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              onClick={onClose}
              className="px-3 py-2 rounded-md text-sm" style={{ color: "#5C574E" }}
            >
              Cancel
            </button>
            <button
              onClick={publish}
              disabled={publishing}
              className="px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2"
              style={{ backgroundColor: "#1A1814", color: "#FAF7F2", opacity: publishing ? 0.6 : 1 }}
            >
              {publishing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
              {publishing ? "Publishing…" : "Publish"}
            </button>
          </div>

          {publishing && (
            <p className="text-xs text-center" style={{ color: "#8B8478" }}>
              This may take 30-60 seconds — uploading images, then creating the page.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function RadioOption({
  checked, onClick, disabled, label, description,
}: {
  checked: boolean;
  onClick: () => void;
  disabled?: boolean;
  label: string;
  description: string;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className="w-full text-left p-3 rounded transition-all flex items-start gap-3"
      style={{
        backgroundColor: checked ? "#FFFFFF" : "transparent",
        border: `1px solid ${checked ? "#1A1814" : "#E8E2D6"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <div
        className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
        style={{ border: `2px solid ${checked ? "#1A1814" : "#8B8478"}` }}
      >
        {checked && <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: "#1A1814" }} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium" style={{ color: "#1A1814" }}>{label}</div>
        <div className="text-xs mt-0.5" style={{ color: "#5C574E" }}>{description}</div>
      </div>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium block mb-1" style={{ color: "#1A1814" }}>{label}</label>
      {hint && <p className="text-xs mb-2" style={{ color: "#8B8478" }}>{hint}</p>}
      {children}
    </div>
  );
}

function deriveSlug(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl);
    const path = u.pathname.replace(/^\/+|\/+$/g, "");
    if (path.length === 0) return "home";
    return path.replace(/\//g, "-").toLowerCase();
  } catch {
    return "page";
  }
}