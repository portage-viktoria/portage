/**
 * Themes listing route.
 *
 * GET /api/portals/[hubId]/themes
 *
 * Queries the HubSpot Source Code API to find every folder at the root of the
 * portal's Design Manager that contains a `theme.json` file. Each such folder
 * is a theme. Returns a list of themes with their paths and labels.
 *
 * This is the first real HubSpot API call Portage makes after OAuth, and it
 * replaces the hardcoded theme picker in the prototype with real data.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/lib/portal-connections";

const HUBSPOT_API_BASE = "https://api.hubapi.com";

type SourceCodeMetadata = {
  folder: boolean;
  path: string;
  name: string;
  children?: string[];
};

async function fetchMetadata(
  accessToken: string,
  path: string
): Promise<SourceCodeMetadata | null> {
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/metadata/${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    if (res.status === 404) return null;
    throw new Error(`metadata fetch ${path} failed: ${res.status}`);
  }
  return res.json();
}

async function fetchThemeJson(
  accessToken: string,
  themePath: string
): Promise<{ label?: string } | null> {
  const url = `${HUBSPOT_API_BASE}/cms/v3/source-code/published/content/${themePath}/theme.json`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/octet-stream",
    },
  });
  if (!res.ok) return null;
  try {
    const text = await res.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ hubId: string }> }
) {
  const { hubId } = await params;
  const hubIdNum = parseInt(hubId, 10);

  if (isNaN(hubIdNum)) {
    return NextResponse.json({ error: "Invalid hub_id" }, { status: 400 });
  }

  // During this milestone, connections are stored with a null user_id.
  // Once Supabase Auth is wired up, resolve the user from the session instead.
  const userId: string | null = null;

  let accessToken: string;
  try {
    accessToken = await getAccessToken(userId, hubIdNum);
  } catch (err) {
    console.error("[themes] failed to get access token:", err);
    return NextResponse.json(
      { error: "Portal not connected" },
      { status: 404 }
    );
  }

  // Step 1: list root folders
  const root = await fetchMetadata(accessToken, "");
  if (!root || !root.children) {
    return NextResponse.json({ themes: [] });
  }

  // Step 2: for each root-level folder, check if it contains theme.json
  const themes: Array<{ path: string; label: string }> = [];

  await Promise.all(
    root.children.map(async (childName) => {
      const themeJson = await fetchThemeJson(accessToken, childName);
      if (themeJson) {
        themes.push({
          path: childName,
          label: themeJson.label ?? childName,
        });
      }
    })
  );

  return NextResponse.json({ themes });
}