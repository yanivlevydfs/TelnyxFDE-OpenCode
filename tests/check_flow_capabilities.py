"""tests/check_flow_capabilities.py — flow + provision capability coverage (step 9).

A NEW self-check added by step 9 of ``docs/build/PROMPTS.md``. It builds the
Conversation Workflow once and asserts that each capability the upgraded
assistant must support is covered by (a) a node, (b) an edge, or (c) an
instruction line. When a capability needs an MCP tool argument that does not
exist, ``assistant/README.md`` lists it under "MCP gaps" — see
``test_no_unacknowledged_mcp_gaps`` below.

Run:  .venv/Scripts/python -m pytest tests/check_flow_capabilities.py -q
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "assistant"))

import flow
import provision

FLOW = flow.build_flow(300)
NODE_IDS = {n["id"] for n in FLOW["nodes"]}
EDGES = FLOW["edges"]


def _has_edge(src: str, dst: str) -> bool:
    """True when an edge links ``src`` to ``dst`` (any condition)."""
    for e in EDGES:
        if e.get("start_node_id") != src:
            continue
        target = e.get("target") or {}
        if isinstance(target, dict) and target.get("type") == "node" and target.get("node_id") == dst:
            return True
    return False


def _instr_blob() -> str:
    """Concatenation of the base instructions and every prompt-node instruction."""
    parts: list[str] = [provision.BASE_INSTRUCTIONS]
    for n in FLOW["nodes"]:
        if n.get("type") == "prompt" and isinstance(n.get("instructions"), str):
            parts.append(n["instructions"])  # type: ignore[arg-type]
        if n.get("type") == "speak" and isinstance(n.get("message"), str):
            parts.append(n["message"])  # type: ignore[arg-type]
    return "\n".join(parts)


INSTR = _instr_blob()
INSTR_L = INSTR.lower()


def _has(*needles: str) -> bool:
    """Case-insensitive substring check; passes when ANY needle is present."""
    return any(n.lower() in INSTR_L for n in needles)


# The complete set of `search_deals` input arguments (the ones zod accepts in
# services/mcp-server/src/server.ts). Used to make sure travel-pattern mappings
# only reference arguments the tool really exposes.
REAL_SEARCH_ARGS = {
    "trip_type", "destination", "country", "category", "weekend",
    "departure_date", "departure_weekday", "min_nights", "max_nights",
    "max_price", "min_discount_pct", "direct_only", "max_layover_hours",
    "time_of_day", "sort",
}


# --------------------------------------------------------------- flight search

def test_search_from_tlv() -> None:
    assert _has("from Tel Aviv", "(TLV)")
    assert "TLV" in INSTR


def test_named_destination() -> None:
    assert "destination" in INSTR
    # An IATA-looking example (three uppercase letters) appears in an instruction.
    assert re.search(r"\b[A-Z]{3}\b", INSTR)


def test_global_discovery_anywhere() -> None:
    assert _has("anywhere")
    assert _has("no destination")


def test_one_way_and_round_trip() -> None:
    assert _has("one way")
    assert _has("round trip")
    assert "trip_type='one_way'" in INSTR


def test_direct_and_connecting() -> None:
    assert _has("direct")
    assert _has("connecting", "layover")
    assert "direct_only" in INSTR


def test_cheapest_first() -> None:
    assert _has("cheapest")
    assert "sort='cheapest'" in INSTR


def test_flexible_dates_and_date_ranges() -> None:
    assert _has("flexible")
    assert "departure_date" in INSTR
    # Either a comma-separated list or an explicit "list of YYYY-MM-DD" wording.
    assert _has("comma-separated", "list of YYYY-MM-DD")


# --------------------------------------------------------------- travel patterns
#
# Each entry is (capability keyword, substrings the mapping sentence must carry
# — at least one of these must appear within the pattern's own mapping sentence).

TRAVEL_PATTERNS: list[tuple[str, tuple[str, ...]]] = [
    ("mid-week", ("departure_weekday='Tuesday'", "departure_weekday='Wednesday'", "category='Midweek Saver'")),
    ("weekend", ("weekend='upcoming'", "category='Weekend'")),
    ("long weekend", ("min_nights=3", "max_nights=3", "weekend='upcoming'")),
    ("short break", ("min_nights=2", "max_nights=2", "Quick Visit")),
    ("4-5 day trip", ("min_nights=3", "max_nights=4")),
    ("7-day trip", ("min_nights=6", "max_nights=6", "category='Weekly'")),
    ("flexible", ("omit departure_date", "sort='cheapest'", "departure_date")),
]


def _travel_patterns_section() -> str:
    """The "Travel patterns" paragraph inside the search_flights instructions.
    Every step-9 travel pattern must live here (with the form ``'<name>'``) so the
    per-pattern mapping is unambiguous and not shadowed by earlier uses of the
    same word (e.g. "this weekend" in the dates section)."""
    i = INSTR.find("Travel patterns")
    assert i >= 0, "no 'Travel patterns' heading in the search_flights instructions"
    # The paragraph runs until the next sentence starting with "Keep context".
    j = INSTR.find("Keep context for the whole call", i)
    assert j >= 0, "Travel patterns paragraph is not followed by the context paragraph"
    return INSTR[i:j]


def test_travel_patterns_listed() -> None:
    section = _travel_patterns_section()
    missing = [name for name, _ in TRAVEL_PATTERNS if f"'{name}'" not in section]
    assert not missing, f"travel patterns missing from the patterns section: {missing}"


def test_travel_patterns_map_to_real_args() -> None:
    """Each pattern must mention at least one real search_deals arg, and no
    fake `arg=` wording that the tool rejects."""
    section = _travel_patterns_section()
    for name, hints in TRAVEL_PATTERNS:
        anchor = f"'{name}'"
        i = section.find(anchor)
        assert i >= 0, f"pattern anchor {anchor!r} missing from the patterns section"
        window = section[i : i + 260]
        assert any(h in window for h in hints), \
            f"{name!r} pattern does not map to a concrete search_deals arg"
        for arg in re.findall(r"([a-z_]+)=", window):
            assert arg in REAL_SEARCH_ARGS, \
                f"{name!r} pattern references fake search_deals arg {arg!r}"


# --------------------------------------------------------------- conversation

def test_natural_follow_ups() -> None:
    assert _has("follow-up", "follow up")
    assert _has("context")


def test_keep_context_for_the_whole_call() -> None:
    assert _has("whole call", "this call", "the call")


def test_refine_preferences() -> None:
    assert _has("refine", "different destination", "changes mind")


def test_compare_prices_and_destinations() -> None:
    assert _has("compare")
    assert _has("prices", "destinations")


def test_offer_alternatives_when_nothing_matches() -> None:
    assert _has("alternative", "another date", "widening")
    assert _has("nothing matches", "nothing", "no match") or _has("returns nothing")


# --------------------------------------------------------------- actions


def test_give_booking_link() -> None:
    assert _has("book", "booking link", "deal_url")
    assert _has("flytlv.app")


def test_send_deal_sms_action() -> None:
    assert "send_deal_sms" in INSTR
    assert "save_deal" in INSTR


def test_send_deal_sms_only_after_yes() -> None:
    assert _has("read back the chosen deal", "read back")
    assert _has("clear yes", "a clear yes")


def test_transfer_to_human_action() -> None:
    assert "transfer_call" in NODE_IDS
    assert "transfer" in flow.build_tools("+15550001", "+15550002", "Agent")[1]["type"]
    assert _has("transfer", "human agent")


def test_end_call_action() -> None:
    assert "hangup_call" in NODE_IDS
    assert "hangup" in flow.build_tools("", "")[0]["type"]


def test_save_flow_wires_sms_enabled_and_link() -> None:
    # The save flow gates SMS on the runtime flag and delivers the booking link.
    save = next(n for n in FLOW["nodes"] if n["id"] == "save_deal")
    assert "{{flag_sms_enabled}}" in save["instructions"]
    assert "send_deal_sms" in save["instructions"]
    assert "deal_url" in save["instructions"]


# --------------------------------------------------------------- safety / accuracy

def test_never_invent_availability_or_prices() -> None:
    assert _has("never invent")
    assert _has("the tool returned", "tool result")


def test_never_claim_booking_completed() -> None:
    # The "you are booked" framing must be explicitly forbidden.
    assert _has("never 'you are booked'", "never say 'you are booked'", "never say \"you are booked\"")


def test_i_found_a_flight_framing() -> None:
    assert _has("I found a flight")


def test_caller_books_themselves_on_flytlv() -> None:
    assert _has("caller books themselves", "they book themselves on flytlv.app")
    assert _has("does not book", "no book or take", "agent does not book")


def test_prices_can_change() -> None:
    assert _has("prices can change", "can change until")
    assert _has("live feed")


def test_read_back_before_sending_link() -> None:
    assert _has("read back the chosen deal", "read back")
    expected_bits = ("destination", "dates", "price with currency", "direct", "connecting")
    body = INSTR_L
    # The readback instruction should call out destination, dates, price and
    # direct vs connecting — the four facts the caller must confirm.
    for bit in expected_bits:
        assert bit.lower() in body, f"readback does not include {bit!r}"


# --------------------------------------------------------------- workflow shape

def test_workflow_supports_search_save_list_transfer_hangup() -> None:
    # Nodes for each action capability exist.
    for nid in ("search_flights", "save_deal", "list_saved", "transfer_call", "hangup_call"):
        assert nid in NODE_IDS, f"missing node {nid!r}"


def test_search_save_faq_edges_exist() -> None:
    assert _has_edge("identify_intent", "search_flights")
    assert _has_edge("search_flights", "save_deal")
    assert _has_edge("search_flights", "identify_intent")
    assert _has_edge("identify_intent", "answer_faq")
    assert _has_edge("answer_faq", "search_flights")


# --------------------------------------------------------------- MCP gaps
#
# If the README lists a capability under "MCP gaps", the self-check must agree:

def test_no_unacknowledged_mcp_gaps() -> None:
    """Any capability step 9 needs that has no real `search_deals` argument
    must be listed under 'MCP gaps' in assistant/README.md. As of step 9 there
    are none: every capability maps to an existing argument or is instruction-level."""
    readme = (ROOT / "assistant" / "README.md").read_text(encoding="utf-8")
    assert "MCP gaps" in readme
    section = _section(readme=readme, title="MCP gaps")
    # No real gap → the section must say "None" (the current state).
    assert "None" in section, "MCP gaps section must declare 'None' or list real gaps"


def _section(readme: str, title: str) -> str:
    """Return the body of the README section under a '## <title>' heading."""
    pat = re.compile(rf"\n##\s+{re.escape(title)}\s*\n(.*?)(?=\n##\s|\Z)", re.DOTALL)
    m = pat.search(readme)
    assert m, f"README has no '## {title}' section"
    return m.group(1)
