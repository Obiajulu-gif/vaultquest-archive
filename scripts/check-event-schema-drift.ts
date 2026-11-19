#!/usr/bin/env node
/**
 * Cross-Service Event Schema Drift Detection Runner (#1090)
 *
 * Usage:
 *   npx tsx scripts/check-event-schema-drift.ts [--strict] [--json] [--role=admin] [--caller=ci]
 *
 * Exit codes:
 *   0: Zero breaking schema drifts detected
 *   1: Breaking schema drift detected across contracts/backend
 *   2: Execution or authorization error
 */

import {
  detectCrossServiceEventDrift,
  SchemaDriftAuthError,
  type DriftAuthContext,
} from "../lib/event-schema-drift.js";

async function main() {
  const args = process.argv.slice(2);
  const strict = args.includes("--strict");
  const jsonOutput = args.includes("--json");
  const callerArg = args.find((a) => a.startsWith("--caller="))?.split("=")[1] || "ci-runner";
  const roleArg = (args.find((a) => a.startsWith("--role="))?.split("=")[1] || "service") as any;

  const auth: DriftAuthContext = {
    caller: callerArg,
    role: roleArg,
  };

  // Sample cross-service event dataset representing contracts & backend
  const sampleEvents = [
    {
      event: {
        topics: ["vaultquest", "v1", "pool_created", "pool_123"],
        payload: {
          pool_id: "pool_123",
          creator: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSWJMGWMMZJOGX7",
          asset: "USDC",
          target_amount: "1000000000",
          opens_at: 1780000000,
          locks_at: 1780086400,
          draws_at: 1780172800,
          admin: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSWJMGWMMZJOGX7",
        },
      },
      schemaKey: "pool_created",
    },
    {
      event: {
        topics: ["vaultquest", "v1", "drip_deposited", "pool_123"],
        payload: {
          pool_id: "pool_123",
          wallet: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSWJMGWMMZJOGX7",
          amount: "5000000",
          shares_delta: "5000000",
          total_deposited: "50000000",
          tvl: "50000000",
        },
      },
      schemaKey: "drip_deposited",
    },
    {
      event: {
        version: "1",
        event_id: "evt_deposit_sub_01",
        event_type: "vault_deposit_submitted",
        timestamp: new Date().toISOString(),
        wallet_address: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSWJMGWMMZJOGX7",
        vault_id: "vault_alpha",
        amount: "5000000",
        tx_hash: "a".repeat(64),
        action_id: "act_1001",
        idempotency_key: "idem_abc_123",
      },
      schemaKey: "vault_deposit_submitted",
    },
    {
      event: {
        version: "1",
        event_id: "evt_prize_drawn_01",
        event_type: "prize_round_drawn",
        timestamp: new Date().toISOString(),
        pool_id: "pool_123",
        round_id: 4,
        winner_wallet: "GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2G2ZVOUSWJMGWMMZJOGX7",
        prize_amount: "25000000",
        randomness_tx_hash: "b".repeat(64),
        eligible_participants: 32,
      },
      schemaKey: "prize_round_drawn",
    },
  ];

  try {
    const result = await detectCrossServiceEventDrift(sampleEvents, {
      auth,
      strict,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("=== VaultQuest Cross-Service Event Schema Drift Report ===");
      console.log(`Timestamp: ${result.timestamp}`);
      console.log(`Evaluated: ${result.totalEventsChecked} events`);
      console.log(`Drifts:    ${result.driftCount}`);
      console.log(`Summary:   ${result.summary}`);
      console.log("----------------------------------------------------------");
      for (const d of result.drifts) {
        console.log(`[${d.severity.toUpperCase()}] ${d.driftType} on ${d.eventName}: ${d.message}`);
      }
    }

    process.exit(result.passed ? 0 : 1);
  } catch (err) {
    if (err instanceof SchemaDriftAuthError) {
      console.error(`Authorization Failure: ${err.message}`);
      process.exit(2);
    }
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

if (process.env.NODE_ENV !== "test") {
  main();
}

