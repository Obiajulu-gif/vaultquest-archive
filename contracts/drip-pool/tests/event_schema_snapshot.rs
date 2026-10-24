use std::collections::BTreeMap;

const DOC: &str = include_str!("../../docs/EVENT_SCHEMA.md");
const SNAPSHOT: &str = include_str!("../../docs/event-schema-v1.snapshot");

fn snapshot_rows() -> BTreeMap<&'static str, Vec<&'static str>> {
    SNAPSHOT
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .map(|line| {
            let mut parts = line.split('|');
            let event = parts.next().expect("event name");
            let topic0 = parts.next().expect("topic 0");
            let topic1 = parts.next().expect("topic 1");
            let fields = parts.next().expect("payload fields");
            assert_eq!(topic0, "vaultquest", "{event} changed envelope topic 0");
            assert_eq!(topic1, "v1", "{event} changed schema version");
            (event, fields.split(',').collect())
        })
        .collect()
}

#[test]
fn documented_event_rows_match_the_versioned_snapshot() {
    for (event, fields) in snapshot_rows() {
        let row = DOC
            .lines()
            .find(|line| line.starts_with(&format!("| `{event}` |")))
            .unwrap_or_else(|| panic!("EVENT_SCHEMA.md is missing required event `{event}`"));

        for field in fields {
            assert!(
                row.contains(&format!("`{field}`")),
                "documented `{event}` payload is missing required field `{field}`"
            );
        }
    }
}

#[test]
fn documented_envelope_remains_indexer_compatible() {
    for expected in [
        "| `0` | `\"vaultquest\"` |",
        "| `1` | schema version, currently `\"v1\"` |",
        "| `2` | event name |",
        "| `3` | pool id when available, otherwise admin/config scope |",
    ] {
        assert!(DOC.contains(expected), "event envelope changed: {expected}");
    }

    assert!(DOC.contains("ledger:tx_hash:event_index"));
    assert!(DOC.contains("Required field changes"));
}
