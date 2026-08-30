import crypto from "crypto";
import type { Logger } from "pino";

export interface ObservabilitySchema {
  approvedDimensions: Set<string>;
  cardinalityBudget: Map<string, number>;
  redactionPatterns: RegExp[];
}

export class ObservabilityService {
  private cardinalityRegistry: Map<string, Set<string>> = new Map();

  constructor(
    private readonly logger: Logger,
    private readonly schema: ObservabilitySchema
  ) {}

  hashIdentifier(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
  }

  redactValue(value: unknown): unknown {
    if (typeof value === "string") {
      if (value.startsWith("G") && value.length === 56) {
        return `[REDACTED_WALLET:${this.hashIdentifier(value)}]`;
      }
      if (/^[0-9a-f]{64}$/.test(value)) {
        return `[REDACTED_TX:${this.hashIdentifier(value)}]`;
      }
    }
    return value;
  }

  recursiveRedact(obj: any): any {
    if (obj === null || typeof obj !== "object") {
      return this.redactValue(obj);
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.recursiveRedact(item));
    }

    const redacted: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (["walletAddress", "wallet", "actor", "txHash", "transactionId"].includes(key)) {
        redacted[key] = this.redactValue(value);
      } else {
        redacted[key] = this.recursiveRedact(value);
      }
    }
    return redacted;
  }

  recordMetric(metricName: string, dimension: string, value: unknown): void {
    if (!this.schema.approvedDimensions.has(dimension)) {
      this.logger.warn({ metric: metricName, dimension }, "Unapproved metric dimension");
      return;
    }

    const key = `${metricName}:${dimension}`;
    if (!this.cardinalityRegistry.has(key)) {
      this.cardinalityRegistry.set(key, new Set());
    }

    const cardinality = this.cardinalityRegistry.get(key)!;
    const budget = this.schema.cardinalityBudget.get(key) ?? 100;

    if (cardinality.size < budget) {
      cardinality.add(String(value));
    } else if (!cardinality.has(String(value))) {
      this.logger.warn(
        { metric: metricName, dimension, cardinality: cardinality.size, budget },
        "Cardinality budget exceeded"
      );
    }
  }

  getCardinalityReport(): Record<string, number> {
    const report: Record<string, number> = {};
    for (const [key, values] of this.cardinalityRegistry) {
      report[key] = values.size;
    }
    return report;
  }
}
