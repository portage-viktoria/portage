/**
 * NoRulebookPrompt — renders the soft nudge when match returns reason=no_rulebook.
 *
 * Two actions:
 *   - "Set up rulebook" → deep links to /themes/[themePath]
 *   - "Proceed without rulebook" → re-calls match with ?force=legacy
 *
 * Drop this into your page review screen, render conditionally when
 * the match response has reason === "no_rulebook".
 */

"use client";

import Link from "next/link";

type Props = {
  hubId: number;
  themePath: string;
  onProceedAnyway: () => void;
  proceeding?: boolean;
};

export default function NoRulebookPrompt({
  hubId,
  themePath,
  onProceedAnyway,
  proceeding,
}: Props) {
  const editorHref = `/themes/${encodeURIComponent(themePath)}?hub_id=${hubId}`;

  return (
    <div className="border border-amber-200 bg-amber-50 rounded-lg p-5 my-4">
      <h3 className="font-semibold text-amber-900">No rulebook for this theme</h3>
      <p className="text-sm text-amber-800 mt-2 leading-relaxed">
        Setting up a rulebook for <code className="bg-amber-100 px-1 py-0.5 rounded text-xs">{themePath}</code> tells
        the migration tool which canonical module to use for each section pattern. With a rulebook,
        every text-and-image section uses the same module, every accordion uses the same module, and so
        on. Match accuracy improves significantly.
      </p>
      <p className="text-sm text-amber-800 mt-2 leading-relaxed">
        Setup takes about 10 minutes. The rulebook is reusable across every project on this theme.
      </p>

      <div className="flex flex-wrap gap-3 mt-4">
        <Link
          href={editorHref}
          className="px-4 py-2 bg-stone-900 text-white rounded text-sm hover:bg-stone-800"
        >
          Set up rulebook
        </Link>
        <button
          type="button"
          onClick={onProceedAnyway}
          disabled={proceeding}
          className="px-4 py-2 bg-white border border-amber-300 text-amber-900 rounded text-sm hover:bg-amber-100 disabled:opacity-50"
        >
          {proceeding ? "Matching…" : "Proceed without rulebook"}
        </button>
      </div>
    </div>
  );
}