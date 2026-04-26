/**
 * Projects list page.
 *
 * Shows all migration projects. Each card displays name, target theme, and
 * the connected portal. Clicking a card navigates to the project detail.
 *
 * "New project" opens an inline panel that walks through portal selection,
 * theme path, and project name.
 */

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, ArrowRight, Folder, Loader2, AlertCircle, X, Check } from "lucide-react";

type Project = {
  id: string;
  hub_id: number;
  theme_path: string;
  theme_label: string | null;
  name: string;
  created_at: string;
  updated_at: string;
};

type ListState =
  | { status: "loading" }
  | { status: "ready"; projects: Project[] }
  | { status: "error"; message: string };

export default function ProjectsPage() {
  const [state, setState] = useState<ListState>({ status: "loading" });
  const [showNew, setShowNew] = useState(false);

  async function loadProjects() {
    setState({ status: "loading" });
    try {
      const res = await fetch("/api/projects");
      const data = await res.json();
      if (data.ok) setState({ status: "ready", projects: data.projects ?? [] });
      else setState({ status: "error", message: data.error ?? "Failed to load" });
    } catch {
      setState({ status: "error", message: "Couldn't reach the server" });
    }
  }

  useEffect(() => { loadProjects(); }, []);

  return (
    <main className="min-h-screen py-16 px-8" style={{ backgroundColor: "#FAF7F2" }}>
      <div className="max-w-4xl mx-auto">
        <Eyebrow />

        <div className="flex items-end justify-between mb-8">
          <div>
            <h1 className="text-3xl font-medium" style={{ color: "#1A1814", letterSpacing: "-0.02em" }}>
              Migration projects
            </h1>
            <p className="text-sm mt-2" style={{ color: "#5C574E" }}>
              Each project targets one HubSpot portal and one theme. Pages added to a project share that target.
            </p>
          </div>
          <button
            onClick={() => setShowNew(true)}
            className="px-4 py-2.5 rounded-md text-sm font-medium inline-flex items-center gap-2"
            style={{ backgroundColor: "#C8512A", color: "#FFFFFF" }}
          >
            <Plus className="w-4 h-4" />
            New project
          </button>
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

        {state.status === "ready" && state.projects.length === 0 && !showNew && (
          <div className="p-8 rounded text-center" style={{ backgroundColor: "#FFFFFF", border: "1px dashed #E8E2D6" }}>
            <Folder className="w-8 h-8 mx-auto" style={{ color: "#8B8478" }} />
            <p className="text-sm mt-3" style={{ color: "#5C574E" }}>
              No projects yet. Create one to start migrating pages.
            </p>
          </div>
        )}

        {state.status === "ready" && state.projects.length > 0 && (
          <div className="space-y-2">
            {state.projects.map((p) => (
              <Link
                key={p.id}
                href={`/projects/${p.id}`}
                className="block p-4 rounded transition-all"
                style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium" style={{ color: "#1A1814" }}>{p.name}</div>
                    <div className="text-xs mt-1" style={{ color: "#5C574E" }}>
                      Portal{" "}
                      <span style={{ fontFamily: "ui-monospace, monospace" }}>{p.hub_id}</span>
                      {" · "}
                      Theme{" "}
                      <span style={{ fontFamily: "ui-monospace, monospace" }}>
                        {p.theme_label ?? p.theme_path}
                      </span>
                    </div>
                  </div>
                  <ArrowRight className="w-4 h-4 flex-shrink-0 mt-1" style={{ color: "#8B8478" }} />
                </div>
              </Link>
            ))}
          </div>
        )}

        {showNew && (
          <NewProjectPanel
            onCreated={() => {
              setShowNew(false);
              loadProjects();
            }}
            onCancel={() => setShowNew(false)}
          />
        )}
      </div>
    </main>
  );
}

function Eyebrow() {
  return (
    <div
      className="inline-flex items-center gap-2 mb-4"
      style={{ color: "#C8512A", fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.1em" }}
    >
      <div className="w-5 h-5 rounded-md flex items-center justify-center" style={{ backgroundColor: "#1A1814" }}>
        <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: "#C8512A" }} />
      </div>
      <Link href="/" className="uppercase no-underline" style={{ color: "#C8512A" }}>Portage</Link>
      <span style={{ color: "#8B8478" }}>/</span>
      <span className="uppercase">projects</span>
    </div>
  );
}

// ============================================================
// New project panel — inline modal-style flow
// ============================================================

function NewProjectPanel({ onCreated, onCancel }: { onCreated: () => void; onCancel: () => void }) {
  const [hubId, setHubId] = useState("");
  const [themePath, setThemePath] = useState("");
  const [name, setName] = useState("");

  const [validation, setValidation] = useState<
    | { status: "idle" }
    | { status: "validating" }
    | { status: "valid"; label: string }
    | { status: "invalid"; error: string }
  >({ status: "idle" });

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  async function validateTheme() {
    if (!hubId || !themePath) return;
    setValidation({ status: "validating" });
    try {
      const res = await fetch(`/api/portals/${hubId}/validate-theme`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: themePath }),
      });
      const data = await res.json();
      if (data.ok) setValidation({ status: "valid", label: data.label });
      else setValidation({ status: "invalid", error: data.error ?? "Invalid theme path" });
    } catch {
      setValidation({ status: "invalid", error: "Couldn't reach server" });
    }
  }

  async function createProject() {
    setCreateError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hubId: parseInt(hubId, 10),
          themePath,
          themeLabel: validation.status === "valid" ? validation.label : undefined,
          name,
        }),
      });
      const data = await res.json();
      if (data.ok) onCreated();
      else setCreateError(data.error ?? "Couldn't create project");
    } catch {
      setCreateError("Couldn't reach server");
    } finally {
      setCreating(false);
    }
  }

  const canValidate = hubId.trim().length > 0 && themePath.trim().length > 0;
  const canCreate =
    validation.status === "valid" && name.trim().length > 0 && !creating;

  return (
    <div className="mt-6 p-5 rounded" style={{ backgroundColor: "#FFFFFF", border: "1px solid #E8E2D6" }}>
      <div className="flex items-center justify-between mb-4">
        <div className="font-medium" style={{ color: "#1A1814" }}>New project</div>
        <button onClick={onCancel} style={{ color: "#8B8478" }}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-4">
        <Field label="Connected portal ID" hint="The hub ID Portage already has connection tokens for.">
          <input
            value={hubId}
            onChange={(e) => { setHubId(e.target.value); setValidation({ status: "idle" }); }}
            placeholder="245978465"
            className="w-full px-3 py-2 rounded-md outline-none"
            style={{ backgroundColor: "#FAF7F2", border: "1px solid #E8E2D6", color: "#1A1814", fontFamily: "ui-monospace, monospace", fontSize: 13 }}
          />
        </Field>

        <Field label="Target theme path" hint="The theme all pages in this project will use.">
          <div className="flex gap-2">
            <input
              value={themePath}
              onChange={(e) => { setThemePath(e.target.value); setValidation({ status: "idle" }); }}
              placeholder="Focus-child or @marketplace/.../Theme"
              className="flex-1 px-3 py-2 rounded-md outline-none"
              style={{ backgroundColor: "#FAF7F2", border: "1px solid #E8E2D6", color: "#1A1814", fontFamily: "ui-monospace, monospace", fontSize: 13 }}
            />
            <button
              onClick={validateTheme}
              disabled={!canValidate || validation.status === "validating"}
              className="px-3 py-2 rounded-md text-sm font-medium"
              style={{
                backgroundColor: "#1A1814", color: "#FAF7F2",
                opacity: !canValidate || validation.status === "validating" ? 0.5 : 1,
              }}
            >
              {validation.status === "validating" ? <Loader2 className="w-4 h-4 animate-spin" /> : "Validate"}
            </button>
          </div>
          {validation.status === "valid" && (
            <div className="mt-2 text-xs flex items-center gap-1.5" style={{ color: "#5A7048" }}>
              <Check className="w-3.5 h-3.5" /> {validation.label}
            </div>
          )}
          {validation.status === "invalid" && (
            <div className="mt-2 text-xs" style={{ color: "#9C3D2B" }}>{validation.error}</div>
          )}
        </Field>

        <Field label="Project name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Albiware redesign, Q1 2026"
            className="w-full px-3 py-2 rounded-md outline-none"
            style={{ backgroundColor: "#FAF7F2", border: "1px solid #E8E2D6", color: "#1A1814", fontSize: 14 }}
          />
        </Field>

        {createError && (
          <div className="text-xs" style={{ color: "#9C3D2B" }}>{createError}</div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            onClick={onCancel}
            className="px-3 py-2 rounded-md text-sm" style={{ color: "#5C574E" }}
          >
            Cancel
          </button>
          <button
            onClick={createProject}
            disabled={!canCreate}
            className="px-4 py-2 rounded-md text-sm font-medium inline-flex items-center gap-2"
            style={{ backgroundColor: "#C8512A", color: "#FFFFFF", opacity: canCreate ? 1 : 0.5 }}
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Create project
          </button>
        </div>
      </div>
    </div>
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