/**
 * /dashboard — the post-login home screen.
 *
 * Lists all projects with: title, hub_id, status badge, page counts, last updated.
 * Each row links into the project. "+ New project" button at the top.
 *
 * Server-side rendered: uses createSupabaseServerClient to load projects
 * for the current user.
 */

import Link from "next/link";
import { createSupabaseServerClient } from "@/lib/auth";
import LogoutButton from "@/components/LogoutButton";

type ProjectStatus = "not_started" | "in_progress" | "completed";

type ProjectRow = {
  id: string;
  name: string;
  hub_id: number;
  theme_path: string;
  status: ProjectStatus;
  created_at: string;
  updated_at?: string;
};

const STATUS_LABELS: Record<ProjectStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

const STATUS_COLORS: Record<ProjectStatus, string> = {
  not_started: "bg-stone-100 text-stone-700 border-stone-200",
  in_progress: "bg-amber-100 text-amber-800 border-amber-200",
  completed: "bg-emerald-100 text-emerald-800 border-emerald-200",
};

export default async function DashboardPage() {
  const supabase = await createSupabaseServerClient();

  // Load all projects
  const { data: projects, error } = await supabase
    .from("projects")
    .select("id, name, hub_id, theme_path, status, created_at, updated_at")
    .order("updated_at", { ascending: false, nullsFirst: false });

  // Load page counts per project (one query, group by project_id)
  const { data: pageRows } = await supabase
    .from("migration_pages")
    .select("project_id, status");

  const pageCounts = new Map<string, { total: number; published: number }>();
  for (const row of pageRows ?? []) {
    const counts = pageCounts.get(row.project_id) ?? { total: 0, published: 0 };
    counts.total += 1;
    if (row.status === "published") counts.published += 1;
    pageCounts.set(row.project_id, counts);
  }

  return (
    <div className="min-h-screen bg-stone-50">
      <header className="bg-white border-b border-stone-200 px-6 py-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold text-stone-900">Portage</h1>
        <LogoutButton />
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-semibold text-stone-900">Projects</h2>
            <p className="text-sm text-stone-600 mt-1">
              {projects?.length ?? 0} {projects?.length === 1 ? "project" : "projects"}
            </p>
          </div>
          <Link
            href="/projects/new"
            className="px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800"
          >
            + New project
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 rounded p-4 mb-4 text-sm">
            Failed to load projects: {error.message}
          </div>
        )}

        {!error && (!projects || projects.length === 0) && (
          <div className="bg-white border border-stone-200 rounded-lg p-12 text-center">
            <p className="text-stone-600 mb-4">No projects yet.</p>
            <Link
              href="/projects/new"
              className="inline-block px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800"
            >
              Create your first project
            </Link>
          </div>
        )}

        {projects && projects.length > 0 && (
          <div className="space-y-3">
            {projects.map((p) => {
              const counts = pageCounts.get(p.id) ?? { total: 0, published: 0 };
              const project = p as ProjectRow;
              return (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="block bg-white border border-stone-200 rounded-lg p-5 hover:border-stone-400 transition"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-1">
                        <h3 className="font-semibold text-stone-900">{project.name}</h3>
                        <span
                          className={`text-xs px-2 py-0.5 rounded border ${STATUS_COLORS[project.status]}`}
                        >
                          {STATUS_LABELS[project.status]}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-sm text-stone-600">
                        <span>
                          Portal{" "}
                          <code className="text-xs bg-stone-100 px-1 py-0.5 rounded">
                            {project.hub_id}
                          </code>
                        </span>
                        <span>
                          {counts.total} {counts.total === 1 ? "page" : "pages"}
                          {counts.published > 0 && ` (${counts.published} migrated)`}
                        </span>
                      </div>
                    </div>
                    <div className="text-xs text-stone-500 shrink-0">
                      {project.updated_at
                        ? new Date(project.updated_at).toLocaleDateString()
                        : new Date(project.created_at).toLocaleDateString()}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}