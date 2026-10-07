"""Unit tests for the assistant definition (assistant/flow.py) and provisioning body.

Checks the Conversation Workflow meets challenge requirement 1: a speak node,
prompt nodes, LLM edges and variable-comparison edges, and a valid graph.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "assistant"))
sys.path.insert(0, str(ROOT / "scripts"))
import flow
import provision

FLOW = flow.build_flow(300)


def test_graph_is_valid() -> None:
    assert flow.validate(FLOW) == []


def test_meets_requirement_1() -> None:
    types = {n["type"] for n in FLOW["nodes"]}
    conditions = {e["condition"]["type"] for e in FLOW["edges"]}
    assert "speak" in types and "prompt" in types
    assert {"llm", "expression", "default"} <= conditions
    assert FLOW["nodes"][0]["type"] == "speak"  # verbatim disclosure first


def test_expression_edges_use_webhook_and_system_variables() -> None:
    names = {e["condition"]["expression"]["left"]["name"]
             for e in FLOW["edges"] if e["condition"]["type"] == "expression"}
    assert names == {"flag_deals_enabled", "backend_degraded", "telnyx_conversation_duration_secs"}


def test_every_expression_variable_has_a_default() -> None:
    for e in FLOW["edges"]:
        if e["condition"]["type"] == "expression":
            name = e["condition"]["expression"]["left"]["name"]
            assert name.startswith("telnyx_") or name in flow.DEFAULT_VARIABLES


def test_validate_catches_broken_graphs() -> None:
    broken = {"start_node_id": "x", "nodes": [{"type": "speak", "id": "s", "message": "hi"}],
              "edges": [{"id": "e", "start_node_id": "s", "target": {"type": "node", "node_id": "nope"},
                         "condition": {"type": "llm", "prompt": "p"}}]}
    problems = flow.validate(broken)
    assert any("start node" in p for p in problems)
    assert any("unknown node" in p for p in problems)
    assert any("default edge" in p for p in problems)


def test_transfer_tool_only_when_configured() -> None:
    assert [t["type"] for t in flow.build_tools("", "")] == ["hangup"]
    tools = flow.build_tools("+15550001", "+15550002")
    assert [t["type"] for t in tools] == ["hangup", "transfer"]
    assert tools[1]["transfer"]["targets"][0]["to"] == "+15550002"


def test_assistant_body_wires_webhook_mcp_and_flow() -> None:
    env = {"ASSISTANT_MODEL": "m", "ASSISTANT_VOICE": "v", "WEBHOOK_URL": "https://wh",
           "MCP_URL": "https://mcp", "MCP_API_KEY": "k"}
    body = provision.assistant_body(env, "mcp-1")
    assert body["dynamic_variables_webhook_url"] == "https://wh"
    assert body["mcp_servers"] == [{"id": "mcp-1"}]
    assert body["dynamic_variables"] == flow.DEFAULT_VARIABLES
    assert body["conversation_flow"]["start_node_id"] == "greeting"
