"""assistant/flow.py — Conversation Workflow, tools and defaults for FlyTLV.

Pure data, no network and no environment reads: the Telnyx AI Assistant
conversation graph, the assistant-level tools and the default dynamic
variables are all built here so they can be unit-tested deterministically and
embedded verbatim into the provisioning body by ``assistant/provision.py``.

The graph satisfies challenge requirement 1 ("AI Assistant with Conversation
Workflow"):

* a **speak node** first — the verbatim disclosure / brand greeting that must
  be delivered word-for-word with no model turn;
* **prompt nodes** for every LLM-driven step (intent detection, flight search,
  save, list, transfer, end);
* **conditional edges** of all three kinds — ``llm`` for intent-based routing,
  ``expression`` (variable comparison) for deterministic routing, and
  ``default`` for the fallback that every speak node must have.

The expression edges deliberately use exactly the variables the dynamic
variables webhook supplies (``flag_deals_enabled``, ``backend_degraded``) plus
one Telnyx system variable (``telnyx_conversation_duration_secs``) for the
timeout-escalation stretch goal — deterministic facts are evaluated before the
model turn, so they never depend on model judgement (design decision #12).

Run tests:  .venv/Scripts/python -m pytest UnitTest/test_assistant.py -q
"""

from __future__ import annotations

from typing import Any

# ----------------------------------------------------------------- node ids
#
# Stable node ids so edges can reference them and ``validate`` can reason about
# the graph without parsing labels. The start node is the greeting speak node.

START_NODE = "greeting"

_NODE_IDS = (
    "greeting",            # speak  — verbatim disclosure + brand greeting
    "identify_intent",     # prompt — the routing hub
    "degraded_notice",     # speak  — apology when the backend is degraded
    "deals_disabled",      # speak  — notice when the deals feature flag is off
    "timeout_escalate",    # prompt — offer a transfer after a long call
    "search_flights",      # prompt — find deals (MCP `search_deals`)
    "save_deal",           # prompt — save a shown deal (MCP `save_deal`)
    "list_saved",          # prompt — read saved deals (MCP `list_saved_deals`)
    "transfer_call",       # prompt — hand off to a human (transfer tool)
    "farewell",            # speak  — goodbye
    "hangup_call",         # prompt — end the call (hangup tool)
)

# --------------------------------------------------------------- speak text
#
# Speak-node messages are delivered verbatim; ``{{variable}}`` placeholders are
# interpolated by Telnyx at runtime from the dynamic variables (webhook or
# defaults). Disclosure first, then the brand line.

GREETING_MESSAGE = (
    "Welcome to the FlyTLV Travel Line. I'm an AI assistant. "
    "I can find you cheap round-trip flights from Tel Aviv, and remember the "
    "ones you save. This call may be recorded for quality."
)

DEGRADED_MESSAGE = (
    "I'm having trouble reaching our flight service right now. "
    "Please try again in a few minutes."
)

DISABLED_MESSAGE = (
    "Flight deal search is temporarily turned off. Please call back later."
)

FAREWELL_MESSAGE = "Thanks for calling FlyTLV. Goodbye."

# ------------------------------------------------------------ prompt text
#
# Node instructions carry the step-specific guidance. They ``append`` to the
# assistant's base instructions (see provision.BASE_INSTRUCTIONS) by default so
# global tone and safety rules stay in force; the two tightly-scoped steps
# (escalation, hangup) ``replace`` the base to keep the model tightly on task.

IDENTIFY_INSTRUCTIONS = (
    "Greet the caller appropriately for this turn. If {{caller_known}} is 'true' "
    "and {{last_saved_deal}} is not empty, acknowledge that they are back and "
    "mention the deal they saved, for example 'Welcome back — last time you "
    "saved {{last_saved_deal}}.' Then find out what they want: search for cheap "
    "flights, save a deal from the ones just read out, hear their saved deals, "
    "or speak to a human. Ask one short clarifying question if the request is "
    "unclear; do not list every option at once."
)

ESCALATE_INSTRUCTIONS = (
    "This call has been going for a while. Briefly offer to transfer the caller "
    "to a human agent, and if they accept, call the transfer tool on the next "
    "turn. Do not continue searching for flights from this step."
)

SEARCH_INSTRUCTIONS = (
    "Help the caller find cheap round-trip flights from Tel Aviv using the "
    "search_deals tool. Map the request to the tool arguments: 'anywhere' or no "
    "place named -> no destination and no country; a city or airport -> "
    "destination (IATA code, e.g. ATH); a whole country -> country (e.g. "
    "'Greece'); 'this weekend' or 'next weekend' -> weekend='upcoming', 'the "
    "weekend after' -> weekend='following' (never compute weekend dates "
    "yourself); a specific day -> departure_date as YYYY-MM-DD. Also pass "
    "max_price or direct_only if the caller asks. For each of the top two to "
    "three deals, read out every detail the tool returned: destination city and "
    "country; departure airport (fromAirport) and arrival airport (toAirport); "
    "the outbound date with its departure and arrival times, airline and flight "
    "number; the return date with its departure and arrival times, airline and "
    "flight number; number of nights; direct or number of stops; and the total "
    "price with currency. Say dates and times naturally (for example 'Monday "
    "the ninth of November, leaving at eight a.m.'). Then offer to save one, "
    "or to text them the deal and booking link with send_deal_sms. If "
    "nothing matches, say so and suggest widening the search. Never invent "
    "prices, dates, times, airports, airlines or URLs: every detail you mention "
    "must come from the tool result, and skip any detail the tool did not return."
)

SAVE_INSTRUCTIONS = (
    "Save one of the deals from the last search using the save_deal tool. If the "
    "caller has not said which one, ask them to pick by position (for example "
    "'the first one'). Pass the deal id exactly as it appeared in the search "
    "result; do not let the caller dictate a price or a URL to save. If the "
    "caller wants the link by text message, call send_deal_sms with the same "
    "deal id: it texts the number they are calling from and also saves the deal. "
    "Never ask for or accept a different phone number."
)

LIST_INSTRUCTIONS = (
    "Read back the deals the caller saved on previous calls using the "
    "list_saved_deals tool, with the same details as a search: destination, "
    "airports, outbound and return dates and times, airline and flight numbers, "
    "nights, stops and price. If they have no saved deals, say so and offer to "
    "search for flights."
)

TRANSFER_INSTRUCTIONS = (
    "The caller wants to speak to a human. Confirm you are transferring them, "
    "then call the transfer tool to connect them. If the transfer tool is not "
    "available, apologize and end the call politely."
)

HANGUP_INSTRUCTIONS = "Use the hangup tool to end the call now."

# ---------------------------------------------------------- default variables
#
# The safe defaults declared on the assistant. The dynamic variables webhook
# overrides them at call start; if the webhook fails entirely these values keep
# the workflow's expression edges from comparing against raw ``{{placeholders}}``.
# They mirror the webhook's degraded-mode response plus the deals feature flag.

DEFAULT_VARIABLES: dict[str, str] = {
    "caller_known": "false",
    "call_count": "0",
    "saved_count": "0",
    "last_saved_deal": "",
    "backend_degraded": "false",
    "flag_deals_enabled": "true",
}

# Allowed edge condition types (the three documented by the Conversation
# Workflows spec). ``validate`` rejects anything else.
_CONDITION_TYPES = {"llm", "expression", "default"}


# ----------------------------------------------------------------- edge helpers

def _edge(edge_id: str, src: str, dst: str, condition: dict[str, Any]) -> dict[str, Any]:
    """Build an edge to another node in the workflow."""
    return {
        "id": edge_id,
        "start_node_id": src,
        "target": {"type": "node", "node_id": dst},
        "condition": condition,
    }


def _llm(prompt: str) -> dict[str, Any]:
    """An LLM (natural-language) edge condition — the model decides intent."""
    return {"type": "llm", "prompt": prompt}


def _default() -> dict[str, Any]:
    """A default fallback edge — taken when no other condition matches."""
    return {"type": "default"}


def _expr_eq(name: str, value: str) -> dict[str, Any]:
    """A variable-comparison edge: ``name == value`` (string comparison).

    ``flag_deals_enabled`` and ``backend_degraded`` are dynamic variables the
    webhook returns as flat strings, so they compare against a string literal.
    """
    return {
        "type": "expression",
        "expression": {
            "type": "comparison",
            "op": "==",
            "left": {"type": "variable", "name": name},
            "right": {"type": "string_literal", "value": value},
        },
    }


def _expr_gte(name: str, value: int) -> dict[str, Any]:
    """A variable-comparison edge: ``name >= value`` (numeric comparison).

    Used for the Telnyx ``telnyx_conversation_duration_secs`` system variable —
    a number — compared against a number literal.
    """
    return {
        "type": "expression",
        "expression": {
            "type": "comparison",
            "op": ">=",
            "left": {"type": "variable", "name": name},
            "right": {"type": "number_literal", "value": value},
        },
    }


# ------------------------------------------------------------------ builders

def build_flow(conversation_timeout_secs: int = 600) -> dict[str, Any]:
    """Return the ``conversation_flow`` graph for the FlyTLV Travel Line.

    ``conversation_timeout_secs`` is the after which the workflow escalates a
    long call to a human (the conversation-duration variable-comparison edge —
    a challenge stretch goal).
    """
    nodes = [
        {"type": "speak", "id": "greeting", "name": "Greeting", "message": GREETING_MESSAGE},
        {"type": "prompt", "id": "identify_intent", "name": "Identify Intent",
         "instructions": IDENTIFY_INSTRUCTIONS, "instructions_mode": "append"},
        {"type": "speak", "id": "degraded_notice", "name": "Backend Degraded",
         "message": DEGRADED_MESSAGE},
        {"type": "speak", "id": "deals_disabled", "name": "Deals Disabled",
         "message": DISABLED_MESSAGE},
        {"type": "prompt", "id": "timeout_escalate", "name": "Escalate After Timeout",
         "instructions": ESCALATE_INSTRUCTIONS, "instructions_mode": "replace"},
        {"type": "prompt", "id": "search_flights", "name": "Search Flights",
         "instructions": SEARCH_INSTRUCTIONS, "instructions_mode": "append"},
        {"type": "prompt", "id": "save_deal", "name": "Save Deal",
         "instructions": SAVE_INSTRUCTIONS, "instructions_mode": "append"},
        {"type": "prompt", "id": "list_saved", "name": "List Saved Deals",
         "instructions": LIST_INSTRUCTIONS, "instructions_mode": "append"},
        {"type": "prompt", "id": "transfer_call", "name": "Transfer To Human",
         "instructions": TRANSFER_INSTRUCTIONS, "instructions_mode": "append"},
        {"type": "speak", "id": "farewell", "name": "Farewell", "message": FAREWELL_MESSAGE},
        {"type": "prompt", "id": "hangup_call", "name": "End Call",
         "instructions": HANGUP_INSTRUCTIONS, "instructions_mode": "replace"},
    ]

    edges = [
        # greeting (speak) → identify_intent (the single required default edge)
        _edge("e_greeting_to_intent", "greeting", "identify_intent", _default()),

        # --- identify_intent: variable-comparison edges first (declaration
        # order is priority order). backend_degraded wins over the flag, which
        # wins over the timeout, before any LLM edge is offered to the model.
        _edge("e_intent_degraded", "identify_intent", "degraded_notice",
              _expr_eq("backend_degraded", "true")),
        _edge("e_intent_disabled", "identify_intent", "deals_disabled",
              _expr_eq("flag_deals_enabled", "false")),
        _edge("e_intent_timeout", "identify_intent", "timeout_escalate",
              _expr_gte("telnyx_conversation_duration_secs", conversation_timeout_secs)),
        # --- identify_intent: LLM edges for the detected intent
        _edge("e_intent_search", "identify_intent", "search_flights",
              _llm("The caller wants to search for cheap flights, or asks where they can fly cheaply.")),
        _edge("e_intent_save", "identify_intent", "save_deal",
              _llm("The caller wants to save one of the deals that were just read out.")),
        _edge("e_intent_list", "identify_intent", "list_saved",
              _llm("The caller wants to hear the deals they saved on previous calls.")),
        _edge("e_intent_transfer", "identify_intent", "transfer_call",
              _llm("The caller wants to speak to a human agent.")),

        # speak nodes each take their one default edge to the close
        _edge("e_degraded_to_farewell", "degraded_notice", "farewell", _default()),
        _edge("e_disabled_to_farewell", "deals_disabled", "farewell", _default()),

        # timeout escalation → transfer
        _edge("e_escalate_to_transfer", "timeout_escalate", "transfer_call",
              _llm("The caller accepts being transferred to a human, or the call should be escalated now.")),
        # ...or the caller declines: wrap up (identify_intent would re-route here
        # every turn once the timeout expression is true, so there is no way back).
        _edge("e_escalate_to_farewell", "timeout_escalate", "farewell",
              _llm("The caller declines the transfer, or a human agent is not available.")),

        # search_flights can lead to saving a deal or back to the hub
        _edge("e_search_to_save", "search_flights", "save_deal",
              _llm("The caller wants to save one of the deals that were just read out.")),
        _edge("e_search_to_intent", "search_flights", "identify_intent",
              _llm("The caller wants a new search, different filters, or a different request.")),

        # save / list return to the hub for whatever comes next
        _edge("e_save_to_intent", "save_deal", "identify_intent",
              _llm("The deal has been saved or could not be saved; the caller may have another request.")),
        _edge("e_list_to_intent", "list_saved", "identify_intent",
              _llm("The caller has heard their saved deals and may have another request.")),

        # transfer then wrap up; farewell (speak) ends on hangup
        _edge("e_transfer_to_farewell", "transfer_call", "farewell",
              _llm("The transfer has been made or is not available; wrap up the call.")),
        _edge("e_farewell_to_hangup", "farewell", "hangup_call", _default()),
    ]

    return {"start_node_id": START_NODE, "nodes": nodes, "edges": edges}


def validate(flow: dict[str, Any]) -> list[str]:
    """Static checks on a conversation-flow graph.

    Returns a list of human-readable problems (empty list = valid). Catches the
    structural mistakes that would break a call: a start node that does not
    exist, edges that point at unknown nodes, an unknown condition type, and a
    speak node without its single required default edge.
    """
    problems: list[str] = []

    nodes = flow.get("nodes") or []
    edges = flow.get("edges") or []
    node_ids: set[Any] = {n.get("id") for n in nodes if isinstance(n, dict)}

    # The start node must exist.
    start = flow.get("start_node_id")
    if start not in node_ids:
        problems.append(f"start node {start!r} not found in nodes")

    # Duplicate node ids would make edges ambiguous.
    seen: dict[Any, int] = {}  # ids may be missing (None); validate reports it
    for n in nodes:
        if isinstance(n, dict):
            seen[n.get("id")] = seen.get(n.get("id"), 0) + 1
    for nid, count in seen.items():
        if count > 1:
            problems.append(f"duplicate node id {nid!r}")

    # Edges: their source must exist, their target must exist, and their
    # condition type must be one of the three documented kinds.
    for e in edges:
        if not isinstance(e, dict):
            continue
        eid = e.get("id")
        src = e.get("start_node_id")
        if src not in node_ids:
            problems.append(f"edge {eid!r} start node {src!r} not found")
        target = e.get("target") or {}
        if isinstance(target, dict) and target.get("type") == "node":
            tid = target.get("node_id")
            if tid not in node_ids:
                problems.append(f"edge {eid!r} targets unknown node {tid!r}")
        cond = e.get("condition") or {}
        ctype = cond.get("type") if isinstance(cond, dict) else None
        if ctype not in _CONDITION_TYPES:
            problems.append(f"edge {eid!r} has unknown condition type {ctype!r}")

    # A speak node must have exactly one outgoing default edge so the
    # conversation always has a defined next step after the scripted line.
    out_by_src: dict[Any, list[dict[str, Any]]] = {}
    for e in edges:
        if isinstance(e, dict):
            out_by_src.setdefault(e.get("start_node_id"), []).append(e)
    for n in nodes:
        if not isinstance(n, dict) or n.get("type") != "speak":
            continue
        out = out_by_src.get(n.get("id"), [])
        defaults = [e for e in out
                    if isinstance(e.get("condition"), dict)
                    and e["condition"].get("type") == "default"]
        if len(defaults) != 1:
            problems.append(
                f"speak node {n.get('id')!r} must have exactly one default edge "
                f"(found {len(defaults)})"
            )

    return problems


def build_tools(transfer_from: str, transfer_to: str) -> list[dict[str, Any]]:
    """Return the assistant-level inline tools.

    The hangup tool is always present (every call should be able to end). The
    transfer tool — which hands the call to a human — is only added when a
    destination is configured (``transfer_to``), so a build without a human
    agent number simply omits it. ``transfer_from`` is the caller-id the
    transferred leg uses (the assistant's own number) and is optional.

    Tool shapes follow the Telnyx Assistant API ``TransferTool`` / ``HangupTool``.
    """
    tools: list[dict[str, Any]] = [{
        "type": "hangup",
        "hangup": {"description": "End the call after saying goodbye."},
    }]

    to = (transfer_to or "").strip()
    if to:
        target: dict[str, Any] = {"to": to}
        frm = (transfer_from or "").strip()
        if frm:
            target["from"] = frm
        tools.append({"type": "transfer", "transfer": {"targets": [target]}})

    return tools
