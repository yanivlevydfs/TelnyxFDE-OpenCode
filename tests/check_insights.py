"""tests/check_insights.py — provision insight_settings self-check (step 20).

A NEW self-check added by step 20 of ``docs/build/PROMPTS.md``. Verifies the
provisioning body wires an ``insight_settings`` group and that the four
caller-intent insight definitions are declared. It does NOT call the Telnyx
API (that needs a key); it only asserts the dry-run shape, which is exactly
what ``--dry-run`` emits.

Run:  .venv/Scripts/python -m pytest tests/check_insights.py -q
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "assistant"))

import provision

ENV = {
    "ASSISTANT_MODEL": "m",
    "ASSISTANT_VOICE": "v",
    "WEBHOOK_URL": "https://wh",
    "MCP_URL": "https://mcp",
    "MCP_API_KEY": "k",
}


def test_assistant_body_has_insight_settings() -> None:
    body = provision.assistant_body(ENV, "mcp-1")
    assert "insight_settings" in body, "assistant body must carry insight_settings"
    assert "insight_group_id" in body["insight_settings"]
    # During --dry-run the id is whatever INSIGHT_GROUP_ID carries (empty default).
    assert body["insight_settings"]["insight_group_id"] == ENV.get("INSIGHT_GROUP_ID", "")


def test_insight_group_id_from_env_flows_through() -> None:
    env = dict(ENV, INSIGHT_GROUP_ID="group-abc")
    body = provision.assistant_body(env, "mcp-1")
    assert body["insight_settings"]["insight_group_id"] == "group-abc"


def test_default_insight_group_name() -> None:
    assert provision._opt({}, "INSIGHT_GROUP_NAME", "FlyTLV caller intent") == "FlyTLV caller intent"


def test_four_insight_definitions() -> None:
    defs = provision._insight_definitions()
    names = [d["name"] for d in defs]
    # Four caller-intent insights: destinations, dates/trip type, deal saved, call outcome.
    assert len(defs) == 4, names
    for d in defs:
        assert isinstance(d["name"], str) and d["name"], "insight name is a non-empty string"
        assert isinstance(d["instructions"], str) and len(d["instructions"]) > 20, "instructions present"


def test_insight_names_are_stable_identifiers() -> None:
    names = [d["name"] for d in provision._insight_definitions()]
    assert len(names) == len(set(names)), "insight names are unique (reusable by name)"


def test_dry_run_prints_insight_settings() -> None:
    # The CLI --dry-run prints the body as JSON; ensure insight_settings survives serialization.
    import json
    body = provision.assistant_body(ENV, "mcp-1")
    s = json.dumps(body)
    assert "insight_settings" in s and "insight_group_id" in s
