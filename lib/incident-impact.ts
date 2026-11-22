export type ImpactSeverity = "low" | "medium" | "high" | "critical";
export type IncidentRecord = { userId: string; recordId: string; operation: string; severity: ImpactSeverity; occurredAt: string };
export type IncidentWindow = { from: string; to: string };

const severityRank: Record<ImpactSeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export function calculateIncidentImpact(records: IncidentRecord[], window: IncidentWindow) {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  const affected = records.filter((record) => {
    const timestamp = Date.parse(record.occurredAt);
    return Number.isFinite(timestamp) && timestamp >= from && timestamp <= to;
  });
  const users = [...new Set(affected.map((record) => record.userId))].sort();
  const recordIds = [...new Set(affected.map((record) => record.recordId))].sort();
  const operations = [...new Set(affected.map((record) => record.operation))].sort();
  const severity = affected.reduce<ImpactSeverity | null>((highest, record) => !highest || severityRank[record.severity] > severityRank[highest] ? record.severity : highest, null);
  return {
    internal: { users, recordIds, operations, severity, count: affected.length },
    shareable: { affectedUserCount: users.length, affectedRecordCount: recordIds.length, operationCount: operations.length, severity, window },
  };
}
