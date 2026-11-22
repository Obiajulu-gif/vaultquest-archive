# Interrupted Action Recovery

VaultQuest records each wallet operation in `action_ledger` before wallet dispatch. The `recovery_checkpoint` JSON value advances through `intent_recorded`, `external_action_started`, `transaction_submitted`, and a terminal or `recovery_required` stage. The checkpoint is stored with the action, so browser and worker restarts do not lose the last known step.

Clients must call `POST /actions/:id/checkpoint` with `{ "stage": "external_action_started" }` and wait for success immediately before invoking an external wallet operation. After a transaction hash is known, `PATCH /actions/:id/submitted` records it. The indexer remains authoritative for confirmation and reversion.

Action responses include `recovery.checkpoint`, `recovery.next_action`, and `recovery.message`. A `continue_wallet_approval` recommendation is only emitted while an action is still at `intent_recorded`. Any action that may have reached the wallet or network requires checking wallet activity or the transaction hash before retrying. Retries must not create a second intent for the same operation; retain the original idempotency key.

Expired submitted actions become orphaned and require reconciliation. Recovery retains their transaction hash and associated pending chain events; it never automatically resubmits or discards linked evidence. Unmatched pending events still follow the existing one-hour retention policy. Maintainers can inspect aged pending operations under the `Abandoned Pending Actions` health category. Actions already marked `external_action_started` require wallet-history verification before any new action is started.

## Deployment

Apply the additive Prisma migration `20260930000000_add_action_recovery_checkpoints` before deploying the backend. No environment variables or contract changes are required.