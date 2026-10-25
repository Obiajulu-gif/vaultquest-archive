export type DependencyState = "healthy" | "degraded" | "unavailable";
export type FallbackAction = "allow" | "read-only" | "block";

export type DependencySnapshot = {
  name: string;
  state: DependencyState;
  checkedAt: string;
  detail?: string;
};

export function fallbackAction(state: DependencyState, critical = false): FallbackAction {
  if (state === "healthy") return "allow";
  if (state === "degraded") return critical ? "read-only" : "allow";
  return "block";
}

/** Evaluate dependencies deterministically and emit only state transitions. */
export function evaluateDegradedMode(
  dependencies: DependencySnapshot[],
  previous: Record<string, DependencyState> = {},
  onTransition?: (event: { dependency: string; from?: DependencyState; to: DependencyState; at: string }) => void,
) {
  const next: Record<string, DependencyState> = {};
  for (const dependency of dependencies) {
    next[dependency.name] = dependency.state;
    if (previous[dependency.name] !== dependency.state) {
      onTransition?.({ dependency: dependency.name, from: previous[dependency.name], to: dependency.state, at: dependency.checkedAt });
    }
  }
  return next;
}
