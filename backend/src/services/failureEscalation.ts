import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { AppError } from "../errors.js";

export const escalationSeverity = z.enum(["low", "medium", "high", "critical"]);
export const escalationPolicyInput = z.object({
  afterMs: z.number().int().min(0).max(2147483647),
  repeatMs: z.number().int().min(60000).max(2147483647),
  maxAttempts: z.number().int().min(1).max(100),
  enabled: z.boolean(),
  expectedVersion: z.number().int().min(1),
}).strict();

const ACTIVE = ["unresolved", "retryable"];

/** Durable in-app alerts; no external delivery is needed to reach the maintainer inbox. */
export class FailureEscalationService {
  constructor(private readonly prisma: PrismaClient, private readonly now = () => new Date()) {}

  policies() { return this.prisma.failureEscalationPolicy.findMany({ orderBy: { severity: "asc" } }); }

  async configure(severity: z.infer<typeof escalationSeverity>, actor: string, input: z.infer<typeof escalationPolicyInput>) {
    escalationSeverity.parse(severity);
    const { expectedVersion, ...data } = escalationPolicyInput.parse(input);
    const result = await this.prisma.failureEscalationPolicy.updateMany({
      where: { severity, version: expectedVersion },
      data: { ...data, updatedBy: actor, version: { increment: 1 } },
    });
    if (!result.count) throw AppError.conflict("ILLEGAL_TRANSITION", "policy changed; reload its current version");
    return this.prisma.failureEscalationPolicy.findUniqueOrThrow({ where: { severity } });
  }

  /** Keyset cursor prevents newer failures from starving older records on bounded ticks. */
  async evaluate(limit = 100, afterId?: string) {
    const rows = await this.prisma.partialFailure.findMany({
      where: { state: { in: ACTIVE }, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" }, take: limit + 1, select: { id: true },
    });
    const batch = rows.slice(0, limit);
    let escalated = 0;
    for (const { id } of batch) {
      escalated += await this.prisma.$transaction(async (tx) => {
        // Resolution and other evaluators serialize on the same failure row.
        await tx.$queryRaw`SELECT id FROM partial_failures WHERE id = ${id}::uuid FOR UPDATE`;
        const failure = await tx.partialFailure.findUnique({ where: { id } });
        if (!failure || !ACTIVE.includes(failure.state)) return 0;
        const policy = await tx.failureEscalationPolicy.findUnique({ where: { severity: failure.severity } });
        if (!policy?.enabled) return 0;
        const last = await tx.failureEscalationAttempt.findFirst({ where: { failureId: id }, orderBy: { attempt: "desc" } });
        const attempt = (last?.attempt ?? 0) + 1;
        const now = this.now();
        const due = Math.max(failure.detectedAt.getTime() + policy.afterMs,
          last ? last.createdAt.getTime() + policy.repeatMs : 0);
        if (attempt > policy.maxAttempts || now.getTime() < due) return 0;
        await tx.failureEscalationAttempt.create({ data: {
          failureId: id, attempt, policyVersion: policy.version, severity: failure.severity, createdAt: now,
        } });
        return 1;
      });
    }
    return { scanned: batch.length, escalated, nextCursor: rows.length > limit ? batch.at(-1)!.id : null };
  }

  /** Resolved/ignored failures disappear immediately, even before the next evaluator tick. */
  report(limit = 100) {
    return this.prisma.failureEscalationAttempt.findMany({
      where: { failure: { state: { in: ACTIVE } } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit,
      include: { failure: { select: { operationType: true, severity: true, state: true, detectedAt: true } } },
    });
  }

  async acknowledge(id: string, actor: string) {
    const { count } = await this.prisma.failureEscalationAttempt.updateMany({
      where: { id, status: "pending", failure: { state: { in: ACTIVE } } },
      data: { status: "acknowledged", acknowledgedAt: this.now(), acknowledgedBy: actor },
    });
    if (!count) throw AppError.conflict("ILLEGAL_TRANSITION", "alert is no longer pending or failure is resolved");
    return this.prisma.failureEscalationAttempt.findUniqueOrThrow({ where: { id } });
  }
}
