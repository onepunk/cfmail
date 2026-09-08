export interface AuditEntry {
  actorEmail: string;
  action: string;
  targetType: string;
  targetId?: string | null;
  detail?: Record<string, unknown>;
}

export function auditStatement(db: D1Database, entry: AuditEntry, now = new Date().toISOString()): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO audit_log (id, actor_email, action, target_type, target_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    entry.actorEmail,
    entry.action,
    entry.targetType,
    entry.targetId || null,
    JSON.stringify(entry.detail || {}),
    now,
  );
}

export async function writeAudit(db: D1Database, entry: AuditEntry, now = new Date().toISOString()): Promise<void> {
  await auditStatement(db, entry, now).run();
}
