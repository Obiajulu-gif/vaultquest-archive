"use strict";
/**
 * Record Provenance Tracking (#867).
 *
 * Provides provenance tracking for imported and derived records in VaultQuest.
 * Models source, import batch, transform version, actor metadata, and lineage tracing
 * even when source records are updated or deleted.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.provenanceManager = exports.RecordProvenanceManager = void 0;
class RecordProvenanceManager {
    requireMetadata(...values) {
        if (values.some((value) => typeof value !== "string" || !value.trim())) {
            throw new Error("Provenance identifiers, version and actor must be non-empty strings.");
        }
    }
    /**
     * Attach provenance metadata to an imported record.
     */
    attachImportProvenance(record, importBatchId, transformVersion, actor) {
        this.requireMetadata(record.id, importBatchId, transformVersion, actor);
        const provenance = {
            id: `prov-${globalThis.crypto.randomUUID()}`,
            source: "import_batch",
            importBatchId,
            transformVersion,
            actor,
            timestamp: new Date().toISOString(),
            parentDeleted: false,
            history: [
                {
                    updatedAt: new Date().toISOString(),
                    actor,
                    action: `imported in batch ${importBatchId}`,
                },
            ],
        };
        return {
            ...record,
            provenance,
        };
    }
    /**
     * Attach provenance metadata to a derived record created from one or more source records.
     */
    attachDerivedProvenance(record, sourceRecords, transformVersion, actor) {
        this.requireMetadata(record.id, transformVersion, actor, ...sourceRecords.map((s) => s.id));
        if (!sourceRecords.length || sourceRecords.some((s) => s.id === record.id)) {
            throw new Error("Derived records require sources distinct from the derived record.");
        }
        const sources = [...new Map(sourceRecords.map((s) => [s.id, s])).values()];
        const sourceIds = sources.map((s) => s.id);
        const provenance = {
            id: `prov-${globalThis.crypto.randomUUID()}`,
            source: "derived_transform",
            transformVersion,
            actor,
            timestamp: new Date().toISOString(),
            sourceRecordIds: sourceIds,
            derivedFrom: [...sourceIds],
            sourceSnapshots: sources.map((s) => ({
                recordId: s.id,
                ...(s.provenance ? { provenance: structuredClone(s.provenance) } : {}),
            })),
            parentDeleted: false,
            history: [
                {
                    updatedAt: new Date().toISOString(),
                    actor,
                    action: `derived from ${sourceIds.length} source records`,
                },
            ],
        };
        return {
            ...record,
            provenance,
        };
    }
    /**
     * Update a record while preserving its original provenance lineage.
     */
    updateRecordPreservingProvenance(existingRecord, updates, actor) {
        this.requireMetadata(actor);
        const now = new Date().toISOString();
        const updatedHistory = [
            ...structuredClone(existingRecord.provenance.history || []),
            {
                updatedAt: now,
                actor,
                action: "record updated",
            },
        ];
        const updatedProvenance = {
            ...structuredClone(existingRecord.provenance),
            history: updatedHistory,
        };
        return {
            ...existingRecord,
            ...updates,
            id: existingRecord.id,
            provenance: updatedProvenance,
        };
    }
    /**
     * Handle deletion of a source record by marking parentDeleted in derived record provenance.
     */
    handleDeletedSourceRecord(derivedRecord, deletedSourceId, actor = "system") {
        this.requireMetadata(deletedSourceId, actor);
        const now = new Date().toISOString();
        const isParent = derivedRecord.provenance.sourceRecordIds?.includes(deletedSourceId) ||
            derivedRecord.provenance.derivedFrom?.includes(deletedSourceId);
        if (!isParent || derivedRecord.provenance.deletedSourceIds?.includes(deletedSourceId)) {
            return derivedRecord;
        }
        const updatedHistory = [
            ...structuredClone(derivedRecord.provenance.history || []),
            {
                updatedAt: now,
                actor,
                action: `source record ${deletedSourceId} was deleted`,
            },
        ];
        return {
            ...derivedRecord,
            provenance: {
                ...structuredClone(derivedRecord.provenance),
                parentDeleted: true,
                deletedSourceIds: [...(derivedRecord.provenance.deletedSourceIds ?? []), deletedSourceId],
                history: updatedHistory,
            },
        };
    }
    /**
     * Export maintainer provenance report across a set of domain records.
     */
    exportProvenanceReport(records) {
        const bySource = Object.create(null);
        const byTransformVersion = Object.create(null);
        let recordsWithProvenance = 0;
        let deletedSourceReferences = 0;
        const reportRecords = [];
        for (const rec of records) {
            if (rec.provenance) {
                recordsWithProvenance++;
                const p = rec.provenance;
                bySource[p.source] = (bySource[p.source] || 0) + 1;
                byTransformVersion[p.transformVersion] = (byTransformVersion[p.transformVersion] || 0) + 1;
                if (p.parentDeleted) {
                    deletedSourceReferences += p.deletedSourceIds?.length ?? 1;
                }
                reportRecords.push({
                    recordId: rec.id,
                    provenance: structuredClone(p),
                });
            }
        }
        return {
            summary: {
                exportedAt: new Date().toISOString(),
                totalRecords: records.length,
                recordsWithProvenance,
                bySource,
                byTransformVersion,
                deletedSourceReferences,
            },
            records: reportRecords,
        };
    }
}
exports.RecordProvenanceManager = RecordProvenanceManager;
exports.provenanceManager = new RecordProvenanceManager();
//# sourceMappingURL=record-provenance.js.map