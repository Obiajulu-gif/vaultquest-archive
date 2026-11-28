#!/usr/bin/env node
/**
 * Dead-letter inspection and safe retry CLI (#1152).
 *
 * The CLI keeps the dead-letter queue in a JSON state file and writes retried
 * jobs to an outbox file that the worker can re-enqueue. Every mutation is
 * authorized through {@link DeadLetterQueueManager}; viewers can inspect but
 * cannot retry, quarantine, or purge.
 *
 * Usage:
 *   node scripts/dead-letter-tooling.mjs --state dlq.json --summary --actor-role operator
 *   node scripts/dead-letter-tooling.mjs --state dlq.json --inspect --queue payouts --json --actor-role auditor
 *   node scripts/dead-letter-tooling.mjs --state dlq.json --preview --id dlq-1 --actor-role operator
 *   node scripts/dead-letter-tooling.mjs --state dlq.json --retry --id dlq-1 --outbox retry.ndjson --actor-role admin
 *   node scripts/dead-letter-tooling.mjs --state dlq.json --quarantine --id dlq-1 --reason poison --actor-role admin
 *   node scripts/dead-letter-tooling.mjs --state dlq.json --purge --id dlq-1 --actor-role admin
 *
 * Safety:
 *   - `--preview` never mutates state; it only returns a redacted dry-run plan.
 *   - `--retry` appends to the outbox only after authorization and quarantine
 *     checks pass, then persists the updated retry count atomically.
 *   - A failed state write leaves the previous state file untouched. If the
 *     outbox append already succeeded, consumers must dedupe on `replayedFrom`
 *     so a retried CLI invocation cannot enqueue the same job twice.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DeadLetterAuthorizationError,
  DeadLetterOperationError,
  DeadLetterQueueManager,
} from "../src/lib/dead-letter-tooling.mjs";

export const DLQ_ACTOR_ROLES = ["admin", "operator", "auditor", "viewer"];
export const DLQ_COMMANDS = [
  "inspect",
  "summary",
  "report",
  "preview",
  "retry",
  "quarantine",
  "purge",
];

export function parseArgs(args) {
  const options = { command: "inspect" };

  const next = (index, flag) => {
    const value = args[index];
    if (value === undefined || value.startsWith("--")) {
      throw new DeadLetterOperationError(`${flag} requires a value.`, "INVALID_ARGUMENT", 400);
    }
    return value;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--inspect":
        options.command = "inspect";
        break;
      case "--summary":
        options.command = "summary";
        break;
      case "--report":
        options.command = "report";
        break;
      case "--preview":
        options.command = "preview";
        break;
      case "--retry":
        options.command = "retry";
        break;
      case "--quarantine":
        options.command = "quarantine";
        break;
      case "--purge":
        options.command = "purge";
        break;
      case "--json":
        options.json = true;
        break;
      case "--state":
        options.state = next(++i, arg);
        break;
      case "--outbox":
        options.outbox = next(++i, arg);
        break;
      case "--id":
        options.id = next(++i, arg);
        break;
      case "--queue":
        options.queue = next(++i, arg);
        break;
      case "--status":
        options.status = next(++i, arg);
        break;
      case "--error-code":
        options.errorCode = next(++i, arg);
        break;
      case "--cursor":
        options.cursor = next(++i, arg);
        break;
      case "--idempotency-key":
        options.idempotencyKey = next(++i, arg);
        break;
      case "--force-reason":
        options.forceReason = next(++i, arg);
        break;
      case "--reason":
        options.reason = next(++i, arg);
        break;
      case "--actor-id":
        options.actorId = next(++i, arg);
        break;
      case "--actor-role": {
        const role = next(++i, arg);
        if (!DLQ_ACTOR_ROLES.includes(role)) {
          throw new DeadLetterOperationError(
            `--actor-role must be one of: ${DLQ_ACTOR_ROLES.join(", ")}.`,
            "INVALID_ARGUMENT",
            400
          );
        }
        options.actorRole = role;
        break;
      }
      case "--scope": {
        const scope = next(++i, arg);
        options.scopes = [...(options.scopes ?? []), scope];
        break;
      }
      case "--limit": {
        const raw = next(++i, arg);
        const limit = Number.parseInt(raw, 10);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
          throw new DeadLetterOperationError(
            `--limit must be an integer between 1 and 200 (received "${raw}").`,
            "INVALID_ARGUMENT",
            400
          );
        }
        options.limit = limit;
        break;
      }
      default:
        throw new DeadLetterOperationError(`Unknown argument "${arg}".`, "INVALID_ARGUMENT", 400);
    }
  }

  return options;
}

export function buildActor(options) {
  return {
    id: options.actorId ?? "cli-operator",
    role: options.actorRole ?? "viewer",
    scopes: options.scopes ?? [],
  };
}

export function createOutboxDispatcher(outboxPath) {
  const target = resolve(outboxPath);
  return async (item) => {
    appendFileSync(
      target,
      `${JSON.stringify({
        queueName: item.queueName,
        jobName: item.jobName,
        payload: item.payload,
        correlationId: item.correlationId,
        replayedFrom: item.id,
      })}\n`,
      "utf8"
    );
  };
}

export function loadState(manager, statePath) {
  const target = resolve(statePath);
  if (!existsSync(target)) {
    return 0;
  }
  const parsed = JSON.parse(readFileSync(target, "utf8"));
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  return manager.importState(entries ?? []);
}

export function saveState(manager, statePath) {
  const target = resolve(statePath);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ entries: manager.exportState() }, null, 2), "utf8");
  renameSync(temporary, target);
}

export async function runDeadLetterToolingCommand(options) {
  if (!options.state) {
    throw new DeadLetterOperationError("--state is required.", "INVALID_ARGUMENT", 400);
  }
  if (!DLQ_COMMANDS.includes(options.command)) {
    throw new DeadLetterOperationError(
      `Unknown command "${options.command}".`,
      "INVALID_ARGUMENT",
      400
    );
  }

  const manager = new DeadLetterQueueManager();
  loadState(manager, options.state);
  const actor = buildActor(options);

  switch (options.command) {
    case "inspect":
      return manager.inspectEntries(actor, {
        queueName: options.queue,
        status: options.status,
        errorCode: options.errorCode,
        limit: options.limit,
        cursor: options.cursor,
      });
    case "summary":
      return manager.getQueueSummary(actor);
    case "report":
      return manager.exportInspectionReport(actor, {
        queueName: options.queue,
        status: options.status,
        errorCode: options.errorCode,
        limit: options.limit,
        cursor: options.cursor,
      });
    case "preview":
      return manager.retryEntry({ actor, id: requireId(options), dryRun: true });
    case "retry": {
      if (!options.outbox) {
        throw new DeadLetterOperationError(
          "--outbox is required with --retry.",
          "INVALID_ARGUMENT",
          400
        );
      }
      const result = await manager.retryEntry({
        actor,
        id: requireId(options),
        dispatcher: createOutboxDispatcher(options.outbox),
        dryRun: false,
        idempotencyKey: options.idempotencyKey,
        forceOverrideReason: options.forceReason,
      });
      saveState(manager, options.state);
      return result;
    }
    case "quarantine": {
      const result = manager.quarantineEntry(actor, requireId(options), options.reason);
      saveState(manager, options.state);
      return result;
    }
    case "purge": {
      const result = manager.purgeEntry(actor, requireId(options));
      saveState(manager, options.state);
      return result;
    }
    default:
      throw new DeadLetterOperationError(
        `Unknown command "${options.command}".`,
        "INVALID_ARGUMENT",
        400
      );
  }
}

function requireId(options) {
  if (!options.id) {
    throw new DeadLetterOperationError(
      `--id is required with --${options.command}.`,
      "INVALID_ARGUMENT",
      400
    );
  }
  return options.id;
}

function formatResult(command, result) {
  if (command === "summary") {
    return [
      `Total: ${result.total}`,
      `Retryable: ${result.retryable}`,
      `Quarantined: ${result.quarantined}`,
      `By status: ${JSON.stringify(result.byStatus)}`,
      `By queue: ${JSON.stringify(result.byQueue)}`,
    ].join("\n");
  }

  if (command === "inspect" || command === "report") {
    const entries = result.entries ?? [];
    const lines = entries.map(
      (entry) => `${entry.id}\t${entry.queueName}/${entry.jobName}\t${entry.status}\t${entry.errorCode}`
    );
    return [`Matched: ${result.totalMatched ?? entries.length}`, ...lines].join("\n");
  }

  if (command === "preview") {
    return `Would replay ${result.id} from ${result.queueName}/${result.jobName} (${result.currentStatus})`;
  }

  if (command === "purge") {
    return `Purged ${result.id}`;
  }

  if (command === "quarantine") {
    return `Quarantined ${result.id}`;
  }

  if (result.deduplicated) {
    return `Already replayed ${result.id} (deduplicated)`;
  }

  return `Replayed ${result.id} (retryCount=${result.retryCount}, attemptsUsed=${result.attemptsUsed})`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runDeadLetterToolingCommand(options);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(formatResult(options.command, result));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      const statusCode =
        err instanceof DeadLetterAuthorizationError || err instanceof DeadLetterOperationError
          ? err.statusCode ?? 400
          : 1;
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(statusCode >= 400 && statusCode < 500 ? 2 : 1);
    });
}
