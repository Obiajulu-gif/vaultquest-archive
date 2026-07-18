#!/usr/bin/env python3
"""Validate Soroban event declarations against EVENT_SCHEMA.md.

The validator intentionally uses only the Python standard library so it can run
in CI without installing extra dependencies. It compares the machine-readable
snapshot in the documentation with every `env.events().publish(...)` call in
`drip-pool/src/lib.rs` and fails on renamed/missing topics or changed tuple
payload arity.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = ROOT / "docs" / "EVENT_SCHEMA.md"
CONTRACT = ROOT / "drip-pool" / "src" / "lib.rs"

SNAPSHOT_RE = re.compile(r"<!-- EVENT_SCHEMA_SNAPSHOT\n(.*?)\nEVENT_SCHEMA_SNAPSHOT -->", re.S)
PUBLISH_RE = re.compile(
    r"events\(\)\.publish\(\s*\(symbol_short!\(\"(?P<scope>[^\"]+)\"\),\s*"
    r"symbol_short!\(\"(?P<name>[^\"]+)\"\)\),\s*(?P<payload>.*?)\s*\);",
    re.S,
)


def payload_arity(payload: str) -> int:
    payload = payload.strip()
    if not (payload.startswith("(") and payload.endswith(")")):
        return 1
    inner = payload[1:-1].strip()
    if not inner:
        return 0
    depth = 0
    commas = 0
    for char in inner:
        if char in "([{":
            depth += 1
        elif char in ")]}" and depth:
            depth -= 1
        elif char == "," and depth == 0:
            commas += 1
    return commas + (0 if inner.endswith(",") else 1)


def load_snapshot() -> dict[str, dict[str, object]]:
    match = SNAPSHOT_RE.search(SCHEMA.read_text(encoding="utf-8"))
    if not match:
        raise AssertionError("EVENT_SCHEMA.md is missing EVENT_SCHEMA_SNAPSHOT")
    rows = json.loads(match.group(1))
    return {row["name"]: row for row in rows}


def emitted_events() -> dict[str, dict[str, object]]:
    source = CONTRACT.read_text(encoding="utf-8")
    events: dict[str, dict[str, object]] = {}
    for match in PUBLISH_RE.finditer(source):
        name = match.group("name")
        if name in events:
            raise AssertionError(f"duplicate event declaration: {name}")
        events[name] = {
            "name": name,
            "topics": [match.group("scope"), name],
            "payload_arity": payload_arity(match.group("payload")),
        }
    return events


def validate() -> None:
    expected = load_snapshot()
    actual = emitted_events()
    if expected != actual:
        missing = sorted(expected.keys() - actual.keys())
        undocumented = sorted(actual.keys() - expected.keys())
        changed = sorted(
            name for name in expected.keys() & actual.keys() if expected[name] != actual[name]
        )
        details = []
        if missing:
            details.append(f"missing from contract: {missing}")
        if undocumented:
            details.append(f"missing from docs: {undocumented}")
        if changed:
            details.extend(
                f"changed {name}: expected={expected[name]!r}, actual={actual[name]!r}"
                for name in changed
            )
        raise AssertionError("event schema drift detected\n" + "\n".join(details))


if __name__ == "__main__":
    try:
        validate()
    except (AssertionError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1)
    print("EVENT_SCHEMA snapshot matches emitted contract events")
