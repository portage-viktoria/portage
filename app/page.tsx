/**
 * Root page — redirects based on auth state.
 *
 * The middleware actually handles this, but having a redirect here too
 * means refreshing / always lands on /dashboard.
 */

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (user) {
    redirect("/dashboard");
  } else {
    redirect("/login");
  }
}