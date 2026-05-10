/**
 * Logout route. POST /api/auth/logout — clears the session.
 */

import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth";

export async function POST() {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.json({ ok: true });
}