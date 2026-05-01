/**
 * One-off re-index endpoint.
 *
 * POST /api/themes/[themePath]/reindex with body { hub_id }
 * Forces a fresh indexing of the theme using the current indexer version.
 * Overwrites any existing theme_indexes row for that hub_id + theme_path.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase";
import { getAccessToken } from "@/lib/portal-connections";
import { indexTheme } from "@/lib/module-indexer";
import { logAudit } from "@/lib/audit";

function decodeThemePath(encoded: string): string {
  return decodeURIComponent(encoded);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ themePath: string }> }
) {
  const { themePath: encodedThemePath } = await params;
  const themePath = decodeThemePath(encodedThemePath);

  let body: { hub_id?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (typeof body.hub_id !== "number") {
    return NextResponse.json({ ok: false, error: "Missing or invalid hub_id" }, { status: 400 });
  }

  const hubId = body.hub_id;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(null, hubId);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Couldn't get access token: ${(err as Error).message}` },
      { status: 401 }
    );
  }

  let indexResult;
  try {
    indexResult = await indexTheme(accessToken, themePath);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Indexing failed: ${(err as Error).message}` },
      { status: 500 }
    );
  }

  const supabase = createServiceClient();

  const { error: upsertError } = await supabase
    .from("theme_indexes")
    .upsert(
      {
        hub_id: hubId,
        theme_path: themePath,
        modules_json: indexResult,
        scanned_at: new Date().toISOString(),
      },
      { onConflict: "hub_id,theme_path" }
    );

  if (upsertError) {
    return NextResponse.json(
      { ok: false, error: `Failed to save index: ${upsertError.message}` },
      { status: 500 }
    );
  }

  await logAudit({
    userId: null,
    hubId,
    action: "theme.indexed",
    resourceType: "theme",
    resourceId: themePath,
    metadata: {
      step: "reindex",
      module_count: indexResult.moduleCount,
      warnings: indexResult.warnings.length,
    },
  });

  return NextResponse.json({
    ok: true,
    moduleCount: indexResult.moduleCount,
    warnings: indexResult.warnings,
    scannedAt: indexResult.scannedAt,
  });
}