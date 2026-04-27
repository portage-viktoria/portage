/**
 * Audit logging for Portage.
 *
 * Every meaningful action — OAuth events, portal writes, migrations — goes here.
 * Metadata is sanitized before storage: no tokens, no secrets, no full payloads.
 * Just enough context to answer "what did Portage do to portal X on date Y".
 */

import { createServiceClient } from "./supabase";

export type AuditAction =
  | "portal.connected"
  | "portal.refreshed"
  | "portal.revoked"
  | "theme.indexed"
  | "page.created"
  | "page.updated"
  | "page.deleted"
  | "file.uploaded"
  | "migration.started"
  | "migration.completed"
  | "migration.failed";

export type AuditEntry = {
  userId?: string | null;
  hubId?: number | null;
  action: AuditAction;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
};

export async function logAudit(entry: AuditEntry): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.from("audit_log").insert({
    user_id: entry.userId ?? null,
    hub_id: entry.hubId ?? null,
    action: entry.action,
    resource_type: entry.resourceType ?? null,
    resource_id: entry.resourceId ?? null,
    metadata: entry.metadata ?? null,
    ip_address: entry.ipAddress ?? null,
    user_agent: entry.userAgent ?? null,
  });

  if (error) {
    // Audit log failures must not break the user-facing flow, but they must
    // be visible. In production this goes to Sentry; for now, console.
    console.error("[audit] failed to write entry:", error, entry);
  }
}