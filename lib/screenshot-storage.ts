/**
 * Supabase Storage helper for source-page screenshots.
 *
 * The bucket "source-screenshots" must be created manually in the Supabase
 * dashboard before this works (see migration-003-source-pages.sql).
 *
 * Files are organized as:
 *   source-screenshots/{hub_id}/{url-hash}/full.png
 *   source-screenshots/{hub_id}/{url-hash}/section-{n}.png
 */

import crypto from "crypto";
import { createServiceClient } from "./supabase";

const BUCKET = "source-screenshots";

export function urlToFolderKey(url: string): string {
  // Hash the URL for a stable, filesystem-safe folder name
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
}

export async function uploadScreenshot(
  hubId: number | null,
  sourceUrl: string,
  filename: string,
  bytes: Uint8Array
): Promise<string | null> {
  const supabase = createServiceClient();
  const folderKey = urlToFolderKey(sourceUrl);
  const path = `${hubId ?? "anon"}/${folderKey}/${filename}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, bytes, {
    contentType: "image/png",
    upsert: true,
  });

  if (error) {
    console.error("[storage] upload failed:", error);
    return null;
  }

  // Return the public URL (works because bucket is public)
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}