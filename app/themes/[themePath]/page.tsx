/**
 * Rulebook editor page — standalone /themes/[themePath].
 *
 * Each pattern shows a dropdown of available modules. The developer picks
 * the canonical module for each pattern they care about. Patterns can be
 * left unassigned (which means rich text fallback for sections of that
 * type).
 *
 * Save commits to the theme_rulebooks table for the hub_id + theme_path.
 *
 * Note: the route segment is URL-encoded — themePath like "Focus-child"
 * becomes "Focus-child"; themePath like "@hubspot/foo" must be URL-encoded
 * as "%40hubspot%2Ffoo".
 */

"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import { PATTERNS, type SectionPattern } from "@/lib/patterns";

type ModuleSummary = {
  name: string;
  label: string;
  description?: string;
  hasRepeater: boolean;
  totalFields: number;
  tags: string[];
};

type RulebookData = {
  rules: Partial<Record<SectionPattern, string | null>>;
};

export default function RulebookEditorPage() {
  const params = useParams<{ themePath: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();

  const themePath = decodeURIComponent(params.themePath);
  const hubIdParam = searchParams.get("hub_id");
  const hubId = hubIdParam ? parseInt(hubIdParam, 10) : null;

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [rules, setRules] = useState<Partial<Record<SectionPattern, string | null>>>({});

  useEffect(() => {
    if (!hubId) {
      setError("Missing hub_id query parameter");
      setLoading(false);
      return;
    }

    (async () => {
      try {
        const res = await fetch(
          `/api/themes/${encodeURIComponent(themePath)}/rulebook?hub_id=${hubId}`
        );
        const data = await res.json();
        if (!res.ok || !data.ok) {
          setError(data.error ?? `Failed to load (${res.status})`);
          setLoading(false);
          return;
        }
        setModules(data.modules ?? []);
        setRules((data.rulebook?.rules as RulebookData["rules"]) ?? {});
        setLoading(false);
      } catch (err) {
        setError(`Network error: ${(err as Error).message}`);
        setLoading(false);
      }
    })();
  }, [themePath, hubId]);

  const modulesByTag = useMemo(() => {
    const map = new Map<string, ModuleSummary[]>();
    for (const m of modules) {
      const primaryTag = m.tags[0] ?? "unknown";
      const list = map.get(primaryTag) ?? [];
      list.push(m);
      map.set(primaryTag, list);
    }
    return map;
  }, [modules]);

  function setRule(pattern: SectionPattern, moduleName: string | null) {
    setRules((prev) => ({ ...prev, [pattern]: moduleName }));
    setSavedOk(false);
  }

  async function save() {
    if (!hubId) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);

    try {
      const res = await fetch(
        `/api/themes/${encodeURIComponent(themePath)}/rulebook`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ hub_id: hubId, rules }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError(data.error ?? `Save failed (${res.status})`);
        setSaving(false);
        return;
      }
      setSavedOk(true);
      setSaving(false);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="text-stone-500">Loading rulebook…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-12">
        <div className="bg-red-50 border border-red-200 text-red-800 rounded p-4">
          {error}
        </div>
      </div>
    );
  }

  const ruledCount = Object.values(rules).filter((v) => typeof v === "string" && v.length > 0).length;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      <div className="mb-6">
        <button
          type="button"
          onClick={() => router.back()}
          className="text-sm text-stone-600 hover:text-stone-900 mb-3"
        >
          ← Back
        </button>
        <h1 className="text-2xl font-semibold text-stone-900">Rulebook for {themePath}</h1>
        <p className="text-stone-600 mt-2 text-sm leading-relaxed">
          For each section pattern below, pick the canonical module from this theme. The
          migration tool will use these consistently across every page using this theme — so
          all your text-and-image sections, for example, end up in the same module.
        </p>
        <p className="text-stone-600 mt-2 text-sm leading-relaxed">
          Patterns you leave unassigned will use HubSpot's built-in rich text module as a
          fallback. You can come back and update the rulebook anytime.
        </p>
      </div>

      <div className="space-y-4">
        {PATTERNS.map((p) => {
          const currentValue = rules[p.id] ?? "";
          const isFallback = p.id === "rich-text-fallback";

          return (
            <div
              key={p.id}
              className="border border-stone-200 rounded-lg p-4 bg-white"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="font-medium text-stone-900">{p.label}</div>
                  <div className="text-sm text-stone-600 mt-0.5">{p.description}</div>
                  {p.hint && (
                    <div className="text-xs text-stone-500 mt-2 italic">{p.hint}</div>
                  )}
                </div>
                <div className="w-72 shrink-0">
                  {isFallback ? (
                    <div className="text-sm text-stone-500 italic px-3 py-2">
                      Always uses @hubspot/rich_text
                    </div>
                  ) : (
                    <select
                      value={currentValue ?? ""}
                      onChange={(e) =>
                        setRule(p.id, e.target.value === "" ? null : e.target.value)
                      }
                      className="w-full px-3 py-2 border border-stone-300 rounded text-sm bg-white"
                    >
                      <option value="">— Use rich text fallback —</option>
                      {Array.from(modulesByTag.entries()).map(([tag, mods]) => (
                        <optgroup key={tag} label={tag}>
                          {mods.map((m) => (
                            <option key={m.name} value={m.name}>
                              {m.label} {m.hasRepeater ? "(repeater)" : ""}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-8 flex items-center justify-between">
        <div className="text-sm text-stone-600">
          {ruledCount} of {PATTERNS.length - 1} patterns assigned
        </div>
        <div className="flex items-center gap-3">
          {savedOk && <div className="text-sm text-green-700">Saved</div>}
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="px-5 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save rulebook"}
          </button>
        </div>
      </div>
    </div>
  );
}