/**
 * Rulebook persistence — load and save per-theme rulebooks.
 *
 * A rulebook is a mapping from section pattern to canonical module name.
 * Stored per-theme (hub_id + theme_path), shared across all projects on that theme.
 */

import { createServiceClient } from "./supabase";
import type { SectionPattern } from "./patterns";

export type Rulebook = {
  id: string;
  hubId: number;
  themePath: string;
  rules: Partial<Record<SectionPattern, string | null>>;
  updatedAt: string;
};

export async function loadRulebook(
  hubId: number,
  themePath: string
): Promise<Rulebook | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("theme_rulebooks")
    .select("id, hub_id, theme_path, rules_json, updated_at")
    .eq("hub_id", hubId)
    .eq("theme_path", themePath)
    .maybeSingle();
  if (error || !data) return null;

  return {
    id: data.id,
    hubId: data.hub_id,
    themePath: data.theme_path,
    rules: (data.rules_json as Rulebook["rules"]) ?? {},
    updatedAt: data.updated_at,
  };
}

export async function saveRulebook(
  hubId: number,
  themePath: string,
  rules: Partial<Record<SectionPattern, string | null>>
): Promise<Rulebook> {
  const supabase = createServiceClient();

  // Upsert
  const { data, error } = await supabase
    .from("theme_rulebooks")
    .upsert(
      {
        hub_id: hubId,
        theme_path: themePath,
        rules_json: rules,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "hub_id,theme_path" }
    )
    .select()
    .single();

  if (error) {
    throw new Error(`Failed to save rulebook: ${error.message}`);
  }

  return {
    id: data.id,
    hubId: data.hub_id,
    themePath: data.theme_path,
    rules: data.rules_json as Rulebook["rules"],
    updatedAt: data.updated_at,
  };
}

/**
 * Resolve a pattern to a module name using a rulebook.
 * Returns null if the pattern has no rule (use rich text fallback).
 */
export function resolvePatternToModule(
  rulebook: Rulebook | null,
  pattern: SectionPattern
): string | null {
  if (!rulebook) return null;
  const ruled = rulebook.rules[pattern];
  return typeof ruled === "string" && ruled.length > 0 ? ruled : null;
}