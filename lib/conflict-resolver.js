"use strict";
/**
 * Deterministic conflict resolver for multi-client edits (#983).
 *
 * Several tabs or devices may edit the same record from the same (or an
 * older) version. Instead of letting whichever request lands last silently
 * overwrite the others, every field remembers which edit wrote it:
 *
 *   clock[field] = { version that wrote it, stamp of the edit that wrote it }
 *
 * An incoming edit names the record version it was composed against
 * (`baseVersion`) and carries a stamp `{ at, clientId }`. Per changed field:
 *
 *   - same value as stored               → unchanged (retries are no-ops)
 *   - field not written after baseVersion → applied (the editor saw the value it replaces)
 *   - field written after baseVersion     → concurrent: the higher stamp wins,
 *                                           ties broken by clientId
 *
 * The outcome is a pure function of the stored record and the edit — no
 * wall clock, no randomness — and, for concurrent edits, independent of the
 * order they arrive in: the same set of edits converges to the same values
 * on every replica. Edits to different fields never conflict.
 *
 * Lives in `lib/` (like `lib/rbac.ts`) so a client can compute the same
 * outcome the server enforces.
 *
 * Complexity: O(k log k) time for k changed fields (fields are visited in
 * sorted order so result lists are deterministic), O(n) space for a record
 * of n fields.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.EditResolutionError = void 0;
exports.compareStamps = compareStamps;
exports.sameFieldValue = sameFieldValue;
exports.resolveEdit = resolveEdit;
class EditResolutionError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "EditResolutionError";
    }
}
exports.EditResolutionError = EditResolutionError;
/** Total order on stamps: time first, then clientId (code-unit order). */
function compareStamps(a, b) {
    if (a.at !== b.at)
        return a.at < b.at ? -1 : 1;
    if (a.clientId === b.clientId)
        return 0;
    return a.clientId < b.clientId ? -1 : 1;
}
/** Value equality for record fields: Dates by instant, everything else by SameValue. */
function sameFieldValue(a, b) {
    if (a instanceof Date && b instanceof Date)
        return a.getTime() === b.getTime();
    return Object.is(a, b);
}
/**
 * Resolves `edit` against `current`. Throws `EditResolutionError` when the
 * edit claims a base version the record never had.
 */
function resolveEdit(current, edit, equals = sameFieldValue) {
    if (edit.baseVersion > current.version) {
        throw new EditResolutionError("BASE_VERSION_AHEAD", `edit is based on version ${edit.baseVersion}, but the record is only at version ${current.version}`);
    }
    const nextVersion = current.version + 1;
    const values = { ...current.values };
    const clocks = { ...current.clocks };
    const applied = [];
    const rejected = [];
    const unchanged = [];
    for (const field of Object.keys(edit.changes).sort()) {
        const incoming = edit.changes[field];
        if (incoming === undefined)
            continue;
        if (equals(incoming, current.values[field])) {
            unchanged.push(field);
            continue;
        }
        const clock = current.clocks[field];
        const concurrent = clock !== undefined && clock.version > edit.baseVersion;
        if (concurrent && compareStamps(edit.stamp, clock.stamp) <= 0) {
            rejected.push({ field, winner: clock.stamp });
            continue;
        }
        values[field] = incoming;
        clocks[field] = { version: nextVersion, stamp: edit.stamp };
        applied.push(field);
    }
    return {
        values,
        version: applied.length > 0 ? nextVersion : current.version,
        clocks,
        applied,
        rejected,
        unchanged,
    };
}
//# sourceMappingURL=conflict-resolver.js.map