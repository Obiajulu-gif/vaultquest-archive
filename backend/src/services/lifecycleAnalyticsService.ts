export const LIFECYCLE_STAGES = ["discovered", "started", "verified", "completed"] as const;
export type LifecycleStage = (typeof LIFECYCLE_STAGES)[number];
export type LifecycleEvent = { subjectId: string; stage: LifecycleStage; outcome: "entered" | "abandoned"; occurredAt: string };

export type LifecycleReport = {
  generatedAt: string;
  stages: Record<LifecycleStage, { entrants: number; completed: number; abandoned: number; conversionRate: number }>;
  transitions: Array<{ from: LifecycleStage; to: LifecycleStage; entrants: number; conversionRate: number }>;
};

export function buildLifecycleReport(events: readonly LifecycleEvent[], generatedAt = "1970-01-01T00:00:00.000Z"): LifecycleReport {
  const bySubject = new Map<string, Map<LifecycleStage, LifecycleEvent>>();
  for (const event of events) {
    if (!LIFECYCLE_STAGES.includes(event.stage)) continue;
    const stages = bySubject.get(event.subjectId) ?? new Map<LifecycleStage, LifecycleEvent>();
    const previous = stages.get(event.stage);
    if (!previous || event.occurredAt < previous.occurredAt) stages.set(event.stage, event);
    bySubject.set(event.subjectId, stages);
  }
  const stages = Object.fromEntries(LIFECYCLE_STAGES.map((stage) => {
    const rows = [...bySubject.values()].map((subject) => subject.get(stage)).filter(Boolean) as LifecycleEvent[];
    const entrants = rows.length;
    const completed = rows.filter((row) => row.outcome === "entered").length;
    const abandoned = rows.filter((row) => row.outcome === "abandoned").length;
    return [stage, { entrants, completed, abandoned, conversionRate: entrants ? completed / entrants : 0 }];
  })) as LifecycleReport["stages"];
  const transitions = LIFECYCLE_STAGES.slice(0, -1).map((from, index) => {
    const to = LIFECYCLE_STAGES[index + 1];
    const entrants = [...bySubject.values()].filter((subject) => subject.has(from)).length;
    const converted = [...bySubject.values()].filter((subject) => subject.has(from) && subject.has(to)).length;
    return { from, to, entrants, conversionRate: entrants ? converted / entrants : 0 };
  });
  return { generatedAt, stages, transitions };
}

export function redactLifecycleReport(report: LifecycleReport) {
  return JSON.parse(JSON.stringify(report)) as LifecycleReport;
}
