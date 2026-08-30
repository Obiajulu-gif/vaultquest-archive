#!/usr/bin/env bash
# Drip-Pool Proxy Upgrade Rollback Command Generator (Issue #554)
#
# Generates the exact sequence of Soroban CLI commands required to roll back a
# DripPool proxy contract (`VaultProxy`) to a previous logic contract address.
#
# Usage:
#   ./scripts/rollback_upgrade.sh <PROXY_CONTRACT_ID> <PREVIOUS_LOGIC_ADDRESS> [NETWORK] [BREAKING]
#
# Examples:
#   ./scripts/rollback_upgrade.sh CC... CB... testnet false
#   ./scripts/rollback_upgrade.sh CC... CB... mainnet true

set -euo pipefail

PROXY_ID="${1:-}"
PREVIOUS_LOGIC="${2:-}"
NETWORK="${3:-testnet}"
BREAKING="${4:-false}"

if [[ -z "$PROXY_ID" || -z "$PREVIOUS_LOGIC" ]]; then
    echo "Error: Missing required arguments."
    echo "Usage: $0 <PROXY_CONTRACT_ID> <PREVIOUS_LOGIC_ADDRESS> [NETWORK] [BREAKING]"
    exit 1
fi

cat <<EOF
================================================================================
  DRIP-POOL PROXY UPGRADE ROLLBACK COMMAND GENERATOR (Issue #554)
================================================================================
Target Proxy Contract : ${PROXY_ID}
Target Logic Contract: ${PREVIOUS_LOGIC}
Network Target       : ${NETWORK}
Breaking Transition  : ${BREAKING}
Execution Timelock   : ~17,280 ledgers (~24 hours)
================================================================================

--- STEP 0: QUERY CURRENT PROXY STATE ---
stellar contract invoke \\
  --id ${PROXY_ID} \\
  --network ${NETWORK} \\
  -- \\
  logic_contract

EOF

if [[ "$BREAKING" == "true" ]]; then
cat <<EOF
--- STEP 1: REGISTER MIGRATION PAIR (Required for Breaking Upgrade) ---
# Must be invoked by a current pool admin prior to propose_upgrade
stellar contract invoke \\
  --id ${PROXY_ID} \\
  --source-account <ADMIN_IDENTITY> \\
  --network ${NETWORK} \\
  -- \\
  register_migration \\
  --caller <ADMIN_ADDRESS> \\
  --from <CURRENT_LOGIC_ADDRESS> \\
  --to ${PREVIOUS_LOGIC}

EOF
fi

cat <<EOF
--- STEP 2: PROPOSE ROLLBACK UPGRADE ---
# Executed by a current pool admin signer. Returns UPGRADE_ID (nonce).
stellar contract invoke \\
  --id ${PROXY_ID} \\
  --source-account <PROPOSER_IDENTITY> \\
  --network ${NETWORK} \\
  -- \\
  propose_upgrade \\
  --caller <PROPOSER_ADDRESS> \\
  --new_logic ${PREVIOUS_LOGIC} \\
  --breaking ${BREAKING}

--- STEP 3: APPROVE ROLLBACK UPGRADE ---
# Must be executed by co-signers in the approver snapshot until threshold is met.
stellar contract invoke \\
  --id ${PROXY_ID} \\
  --source-account <APPROVER_IDENTITY> \\
  --network ${NETWORK} \\
  -- \\
  approve_upgrade \\
  --caller <APPROVER_ADDRESS> \\
  --upgrade_id <UPGRADE_ID>

--- STEP 4: MONITOR TIMELOCK (& EMERGENCY PAUSE IF NEEDED) ---
# Query pending proposal until sequence >= ready_at:
stellar contract invoke \\
  --id ${PROXY_ID} \\
  --network ${NETWORK} \\
  -- \\
  pending_upgrade \\
  --upgrade_id <UPGRADE_ID>

--- STEP 5: EXECUTE ROLLBACK ---
# Triggered by any pool admin once threshold is met and ready_at sequence is reached.
stellar contract invoke \\
  --id ${PROXY_ID} \\
  --source-account <EXECUTOR_IDENTITY> \\
  --network ${NETWORK} \\
  -- \\
  execute_upgrade \\
  --caller <EXECUTOR_ADDRESS> \\
  --upgrade_id <UPGRADE_ID>

================================================================================
  EMERGENCY ABORT (Single Signer Cancel)
  Any single current pool admin can cancel a pending upgrade immediately:
  stellar contract invoke --id ${PROXY_ID} --source-account <ADMIN> --network ${NETWORK} -- cancel_upgrade --caller <ADMIN_ADDRESS> --upgrade_id <UPGRADE_ID>
================================================================================
EOF
