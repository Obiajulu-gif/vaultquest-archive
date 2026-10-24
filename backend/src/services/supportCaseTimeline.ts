import { createHash } from "node:crypto";

export type SupportEventType = "status" | "note" | "evidence" | "escalation" | "resolution";

export interface SupportTimelineEvent {
  id: string;
  caseId: string;
  type: SupportEventType;
  actorId: string;
  visibility: "private" | "user";
  body: string;
  createdAt: string;
  sequence: number;
  previousHash: string | null;
  hash: string;
}

function eventHash(event: Omit<SupportTimelineEvent, "hash">): string {
  return createHash("sha256").update(JSON.stringify(event)).digest("hex");
}

/** Append-only support case timeline with explicit user/private visibility. */
export class SupportCaseTimeline {
  private readonly events = new Map<string, SupportTimelineEvent[]>();

  append(input: Omit<SupportTimelineEvent, "id" | "sequence" | "previousHash" | "hash">): SupportTimelineEvent {
    const current = this.events.get(input.caseId) ?? [];
    const previous = current.at(-1) ?? null;
    const event = {
      ...input,
      id: `${input.caseId}:${current.length + 1}`,
      sequence: current.length + 1,
      previousHash: previous?.hash ?? null,
      hash: ""
    } as SupportTimelineEvent;
    event.hash = eventHash(event);
    current.push(event);
    this.events.set(input.caseId, current);
    return { ...event };
  }

  list(caseId: string, viewer: "user" | "maintainer" = "maintainer"): SupportTimelineEvent[] {
    const events = this.events.get(caseId) ?? [];
    return events
      .filter((event) => viewer === "maintainer" || event.visibility === "user")
      .map((event) => ({ ...event }));
  }

  verify(caseId: string): { valid: boolean; checked: number; brokenSequence?: number } {
    const events = this.events.get(caseId) ?? [];
    let previousHash: string | null = null;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const expected = eventHash({ ...event, hash: undefined } as unknown as Omit<SupportTimelineEvent, "hash">);
      if (event.sequence !== index + 1 || event.previousHash !== previousHash || event.hash !== expected) {
        return { valid: false, checked: index + 1, brokenSequence: event.sequence };
      }
      previousHash = event.hash;
    }
    return { valid: true, checked: events.length };
  }
}

