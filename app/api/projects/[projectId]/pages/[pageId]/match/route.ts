/**
 * Admin endpoint: reload reference catalog.
 *
 * POST /api/admin/reload-catalog
 *
 * Clears the in-memory catalog cache. The next call to loadCatalog() will
 * re-parse the bluleadz-modules.html file from disk.
 *
 * Useful after editing the reference template — push your changes, hit this
 * endpoint, the next match call uses the fresh catalog.
 *
 * Auth: any logged-in user (gated by middleware).
 */

import { NextResponse } from "next/server";
import { clearCatalogCache, loadCatalog } from "@/lib/reference-catalog";

export async function POST() {
  clearCatalogCache();
  try {
    const catalog = await loadCatalog();
    return NextResponse.json({
      ok: true,
      message: "Catalog reloaded",
      entryCount: catalog.entries.length,
      entries: catalog.entries.map((e) => ({ id: e.id, label: e.label })),
      loadedAt: catalog.loadedAt,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: `Failed to reload catalog: ${(err as Error).message}` },
      { status: 500 }
    );
  }
}