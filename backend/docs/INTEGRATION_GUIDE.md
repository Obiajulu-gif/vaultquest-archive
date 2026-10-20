# Integration Guide: Schema Evolution & Incident Drills

This guide explains how to integrate the schema evolution and incident drill features into the VaultQuest backend.

## Table of Contents

1. [Schema Evolution Integration](#schema-evolution-integration)
2. [Incident Drill Integration](#incident-drill-integration)
3. [Configuration](#configuration)
4. [Monitoring & Observability](#monitoring--observability)
5. [Production Deployment](#production-deployment)

---

## Schema Evolution Integration

### 1. Add API Versioning Middleware

Update `src/server.ts` to include versioning middleware:

```typescript
import { versioningHook } from "./middleware/apiVersioning.js";

// Apply to all routes
app.addHook("preHandler", versioningHook({
  defaultVersion: "v2",
  supportedVersions: ["v1", "v2"],
}));
```

### 2. Register Schema Validation Routes

Add to `src/server.ts`:

```typescript
import { schemaValidationRoutes } from "./routes/admin/schemaValidation.js";

// Admin routes (protected by adminRead guard)
app.register(schemaValidationRoutes(prisma, { adminRead }));
```

### 3. Update Action Response Serialization

Modify `src/routes/actions.ts`:

```typescript
import { emitVersionedResponse, API_RESPONSE_SCHEMAS } from "../schemas/versioning.js";
import { getApiVersion } from "../middleware/apiVersioning.js";

// In GET /actions/:id handler
const action = await ledger.getAction(id);
const apiVersion = getApiVersion(req);

const { response } = emitVersionedResponse(
  API_RESPONSE_SCHEMAS.action,
  serialize(action),
  apiVersion
);

return ok(response);
```

### 4. Update Action Payload Parsing

Modify `src/services/ledger.ts`:

```typescript
import { readVersionedPayload, ACTION_PAYLOAD_SCHEMAS } from "../schemas/versioning.js";

// When reading action payloads
const action = await prisma.actionLedger.findUnique({ where: { id } });
const parsed = readVersionedPayload(
  ACTION_PAYLOAD_SCHEMAS.deposit,
  action.actionPayload
);

if (!parsed) {
  // Quarantine unreadable payload
  await this.quarantineAction(id, "SCHEMA_PARSE_FAILURE");
  throw new Error("Action payload could not be parsed");
}

// Log unknown fields
if (parsed.hadUnknownFields) {
  logger.warn({ actionId: id, version: parsed.version }, 
    "action payload contains unknown fields");
}

// Use parsed.data safely
const vaultId = parsed.data.vault_id;
```

### 5. Environment Variables

Add to `.env`:

```bash
ENABLE_API_VERSIONING=true
DEFAULT_API_VERSION=v2
SCHEMA_VERSION_LOGGING=true
QUARANTINE_UNREADABLE_PAYLOADS=true
```

### 6. Monitoring

Add metrics collection in `src/services/prometheusMetrics.ts`:

```typescript
const schemaVersionCounter = new Counter({
  name: "vaultquest_schema_version_usage",
  help: "API requests by schema version",
  labelNames: ["version", "endpoint"],
});

const unknownFieldsCounter = new Counter({
  name: "vaultquest_unknown_fields_detected",
  help: "Action payloads with unknown fields",
  labelNames: ["action_type", "version"],
});
```

---

## Incident Drill Integration

### 1. Register Drill Execution Routes

Add to `src/server.ts`:

```typescript
import { drillExecutionRoutes } from "./routes/admin/drillExecution.js";

// Admin routes (protected by adminWrite guard)
app.register(drillExecutionRoutes(
  prisma,
  ledger,
  recovery,
  quests,
  indexer,
  { adminWrite }
));
```

### 2. Optional: Enable Drill History

Run migration:

```bash
psql $DATABASE_URL < backend/prisma/migrations/add_drill_history.sql
```

Set environment variable:

```bash
STORE_DRILL_HISTORY=true
```

### 3. Schedule Automated Drills

Add to crontab or CI/CD pipeline:

```bash
# Run monthly stuck_deposit drill
0 3 1 * * cd /opt/vaultquest/backend && npm run drill -- --type stuck_deposit --environment sandbox --output ./drill-results/stuck-deposit-$(date +\%Y\%m\%d).json

# Run all drills quarterly
0 4 1 */3 * cd /opt/vaultquest/backend && npm run drill:all -- --environment sandbox --output ./drill-results/all-drills-$(date +\%Y\%m\%d).json
```

### 4. Alert on Drill Failures

Integrate with monitoring system:

```typescript
// src/scripts/runDrill.ts (already included)
// Check exit code in monitoring script:

if (results.some(r => !r.passed)) {
  // Send alert to PagerDuty, Slack, etc.
  await sendAlert({
    severity: "high",
    title: "Incident Drill Failed",
    details: results.filter(r => !r.passed),
  });
}
```

### 5. CLI Usage

```bash
# Run single drill
npm run drill -- --type stuck_deposit --environment sandbox

# Run all drills
npm run drill:all -- --environment test

# Save results to file
npm run drill -- --type settlement_timeout --environment sandbox --output results.json

# Disable auto-rollback (for inspection)
npm run drill -- --type quest_race --environment test --no-rollback
```

### 6. API Usage

```bash
# Execute drill via API
curl -X POST https://api.vaultquest.io/admin/drills/execute \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "stuck_deposit",
    "environment": "sandbox",
    "autoRollback": true
  }'

# Get drill history
curl https://api.vaultquest.io/admin/drills/history?limit=20 \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# List available drills
curl https://api.vaultquest.io/admin/drills/catalog \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

---

## Configuration

### Environment Variables

```bash
# Schema Evolution
ENABLE_API_VERSIONING=true
DEFAULT_API_VERSION=v2
SCHEMA_VERSION_LOGGING=true
QUARANTINE_UNREADABLE_PAYLOADS=true

# Incident Drills
STORE_DRILL_HISTORY=true
DRILL_ENVIRONMENT=sandbox
DRILL_AUTO_ROLLBACK=true
DRILL_RESULTS_DIR=./drill-results

# Recovery Settings (used by drills)
RECOVERY_STALE_THRESHOLD_MS=1800000
RECOVERY_MAX_ATTEMPTS=3
```

### Feature Flags

Add to `src/services/featureFlags.ts`:

```typescript
export const FEATURES = {
  API_VERSIONING: process.env.ENABLE_API_VERSIONING === "true",
  DRILL_HISTORY: process.env.STORE_DRILL_HISTORY === "true",
  SCHEMA_VERSION_LOGGING: process.env.SCHEMA_VERSION_LOGGING === "true",
} as const;
```

---

## Monitoring & Observability

### Metrics to Track

1. **Schema Version Usage**
   ```typescript
   schema_version_usage{version="v1",endpoint="/actions/:id"} 45
   schema_version_usage{version="v2",endpoint="/actions/:id"} 155
   ```

2. **Unknown Fields Detected**
   ```typescript
   unknown_fields_detected{action_type="deposit",version="v1"} 12
   ```

3. **Drill Execution Results**
   ```typescript
   drill_execution_total{drill="stuck_deposit",passed="true"} 24
   drill_execution_total{drill="stuck_deposit",passed="false"} 1
   drill_execution_duration_ms{drill="indexer_lag"} 2345
   ```

4. **Unreadable Payloads**
   ```typescript
   unreadable_payloads_total{action_type="deposit"} 0
   ```

### Alerts

Set up alerts for:

- Drill failure (any drill returns `passed: false`)
- High unknown field rate (>10% of payloads)
- Unreadable payload detected (should be 0)
- Deprecated version usage spike (v1 usage increases)

### Dashboards

Create Grafana dashboard with panels:

1. API version distribution (pie chart)
2. Drill execution history (time series)
3. Schema compatibility issues (table)
4. Unknown field detection rate (graph)

---

## Production Deployment

### Pre-Deployment Checklist

- [ ] Run schema evolution tests: `npm run test:schema`
- [ ] Run drill tests: `npm run test:drills`
- [ ] Execute all drills in sandbox: `npm run drill:all -- --environment sandbox`
- [ ] Review drill results for failures
- [ ] Update API documentation with version header info
- [ ] Set `DEFAULT_API_VERSION=v2` in production `.env`
- [ ] Enable schema version logging: `SCHEMA_VERSION_LOGGING=true`
- [ ] Configure drill schedule in cron/CI
- [ ] Set up monitoring alerts

### Deployment Steps

1. **Deploy Code**
   ```bash
   git checkout main
   git pull
   npm run build
   pm2 restart vaultquest-backend
   ```

2. **Verify API Versioning**
   ```bash
   # Test v1 response
   curl https://api.vaultquest.io/actions/123 \
     -H "Accept-Version: v1"
   
   # Test v2 response
   curl https://api.vaultquest.io/actions/123 \
     -H "Accept-Version: v2"
   
   # Check deprecation headers
   curl -I https://api.vaultquest.io/actions/123 \
     -H "Accept-Version: v1" | grep "X-API-Version"
   ```

3. **Run Post-Deployment Drill**
   ```bash
   # From CI/CD pipeline or manually
   npm run drill -- --type stuck_deposit --environment sandbox
   ```

4. **Monitor Metrics**
   - Check Grafana for schema version distribution
   - Verify no unreadable payload alerts
   - Confirm drill execution metrics appear

### Rollback Plan

If issues detected:

1. **Rollback code**: `git revert HEAD && npm run build && pm2 restart`
2. **Verify old code handles new payloads**: Run compatibility tests
3. **Check for data loss**: Query for unknown fields preserved
4. **Re-run drills**: Confirm recovery procedures still work

### Post-Deployment

- Monitor schema version usage for 24 hours
- Review logs for unknown field warnings
- Check drill execution history weekly
- Update client applications to use v2 API
- Plan v1 sunset communication (6+ months notice)

---

## Testing

```bash
# Run all new tests
npm run test:schema
npm run test:drills

# Run integration tests
npm test -- tests/e2e

# Lint code
npm run lint

# Type check
npm run build
```

---

## Support

For issues or questions:

- Documentation: `backend/docs/SCHEMA_EVOLUTION.md`, `backend/docs/INCIDENT_DRILL_RUNBOOK.md`
- Implementation: `backend/src/schemas/versioning.ts`, `backend/src/operations/incidentDrill.ts`
- Tests: `backend/tests/versioning.spec.ts`, `backend/tests/incidentDrill.spec.ts`

---

## Next Steps

1. Integrate into `src/server.ts`
2. Update `.env` with new variables
3. Run tests to verify
4. Deploy to sandbox environment
5. Execute drills manually
6. Schedule automated drill execution
7. Set up monitoring and alerts
8. Plan v1 API sunset timeline
