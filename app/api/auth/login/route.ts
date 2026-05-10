/**
 * Login route.
 * POST /api/auth/login with { email, password }.
 * On success, Supabase sets the session cookies; we just return ok.
 */

import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/auth";

export async function POST(request: NextRequest) {
  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
  }

  if (!body.email || !body.password) {
    return NextResponse.json(
      { ok: false, error: "Email and password are required" },
      { status: 400 }
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: body.email,
    password: body.password,
  });

  if (error || !data.user) {
    return NextResponse.json(
      { ok: false, error: error?.message ?? "Invalid credentials" },
      { status: 401 }
    );
  }

  return NextResponse.json({ ok: true, user: { id: data.user.id, email: data.user.email } });
}