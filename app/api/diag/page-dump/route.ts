/**
 * Diagnostic endpoint: dump a real HubSpot page's layoutSections JSON.
 *
 * GET /api/diag/page-dump?hubId=<id>&pageId=<id>
 *
 * Use this to fetch an existing page from a portal and see exactly what
 * HubSpot's API returns for layoutSections, widgets, and widgetContainers.
 * That gives us the ground-truth shape to model our publish payload against.
 *
 * This is a development tool. We'll remove it once we've nailed the shape.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/portal-connections";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

export async function GET(request: NextRequest) {
  const hubIdParam = request.nextUrl.searchParams.get("hubId");
  const pageIdParam = request.nextUrl.searchParams.get("pageId");

  if (!hubIdParam || !pageIdParam) {
    return NextResponse.json(
      {
        ok: false,
        error: "Provide both hubId and pageId query params.",
        example: "/api/diag/page-dump?hubId=245978465&pageId=12345678",
      },
      { status: 400 }
    );
  }

  const hubId = parseInt(hubIdParam, 10);
  if (!Number.isInteger(hubId)) {
    return NextResponse.json({ ok: false, error: "Invalid hubId" }, { status: 400 });
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(null, hubId);
  } catch {
    return NextResponse.json(
      { ok: false, error: "Portal not connected" },
      { status: 404 }
    );
  }

  const url = `${HUBSPOT_API_BASE}/cms/v3/pages/site-pages/${pageIdParam}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      {
        ok: false,
        error: `HubSpot returned ${res.status}`,
        body: text.slice(0, 1000),
      },
      { status: res.status }
    );
  }

  const data = await res.json();

  // Return only the structural fields that matter for understanding the
  // shape. Skip the noise (timestamps, IDs, SEO settings, etc.)
  return NextResponse.json({
    ok: true,
    pageMetadata: {
      id: data.id,
      name: data.name,
      slug: data.slug,
      templatePath: data.templatePath,
      currentState: data.currentState,
    },
    layoutSections: data.layoutSections ?? null,
    widgets: data.widgets ?? null,
    widgetContainers: data.widgetContainers ?? null,
  });
}