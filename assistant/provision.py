"""assistant/provision.py — provision the FlyTLV Travel Line assistant.

A small CLI that builds the assistant definition and creates it through the
official Telnyx Python SDK. In order it provisions:

1. an **integration secret** holding the MCP server bearer token (``MCP_API_KEY``),
2. an **MCP server** (``/ai/mcp_servers``) pointing at the deployed MCP Edge
   Function, authenticated with the secret above so Telnyx sends the bearer
   token on every tool call,
3. a **conversation insight group** (``/ai/conversations/insight-groups``)
   "FlyTLV caller intent" with four insights (destinations, dates/trip type,
   deal saved, call outcome) so Telnyx summarizes every conversation, reused by
   name on re-runs,
4. the **AI assistant** (``/ai/assistants``) with the conversation workflow,
   dynamic variables webhook, MCP server reference, tools and
   ``insight_settings`` built by ``assistant/flow.py``,
5. links a **phone number** to the assistant so the line is callable.

Every URL, id, model and voice comes from environment variables / Telnyx Edge
secrets — nothing is hardcoded. ``--dry-run`` skips all API calls and prints
the assistant body that *would* be created, which is what the unit test uses.

Run tests:  .venv/Scripts/python -m pytest tests/test_assistant.py -q
Run for real (from the repo root):
    TELNYX_API_KEY=... MCP_URL=... MCP_API_KEY=... WEBHOOK_URL=... \
    ASSISTANT_MODEL=... ASSISTANT_VOICE=... python assistant/provision.py
Dry run:
    python assistant/provision.py --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import telnyx

# Make ``shared/common.py`` importable both when this file is run as a script
# (from the repo root) and when it is imported by the test suite.
_REPO_SHARED = str(Path(__file__).resolve().parent.parent / "shared")
if _REPO_SHARED not in sys.path:
    sys.path.insert(0, _REPO_SHARED)

import common as c
import flow

# ------------------------------------------------------------- base prompt
#
# The assistant-level instructions. Prompt-node instructions ``append`` to this,
# so it carries the global policy: identity, data integrity (no invented
# prices), voice conciseness and a currency rule. Dynamic-variable placeholders
# are interpolated by Telnyx at call time.

def _checked_flow(conversation_timeout_secs: int, hangup_tool_id: str | None = None) -> dict[str, Any]:
    """The workflow graph, refused before any API call if validate() finds a problem."""
    graph = flow.build_flow(conversation_timeout_secs, hangup_tool_id)
    problems = flow.validate(graph)
    if problems:
        raise ValueError("invalid conversation flow: " + "; ".join(problems))
    return graph


BASE_INSTRUCTIONS = (
    "You are the FlyTLV Travel Line voice assistant. You help people find cheap "
    "flights from Tel Aviv (Ben Gurion, TLV), round trip or one way, direct or "
    "connecting, over the phone — using tools for all flight data so you never invent "
    "prices, dates, airlines, cities or booking URLs. Flights depart only from TLV. "
    "Speak only what the tools returned: frame results as 'I found a flight', never "
    "'you are booked' — the agent does not book or take payment, and the caller books "
    "themselves on flytlv.app at the deal_url. Make plain that the deals come from the "
    "live flytlv.app feed and that prices and availability can change until the caller "
    "books on flytlv.app. "
    "Never add general travel knowledge or guesses about baggage, fares, "
    "visas or airline policies: the deals carry none of that, so say to check the "
    "airline or the flytlv.app booking page. "
    "Keep the conversation natural: pick up follow-up questions on the same call "
    "without restarting, refine the search when the caller changes mind, compare "
    "prices and destinations when asked, and offer alternatives when nothing matches. "
    "Before sending a booking link by SMS, read back the destination, dates, price "
    "with currency and direct vs connecting, and get a clear yes from the caller. "
    "Keep responses short and spoken-friendly; spell amounts naturally (for "
    "example 'sixty-four dollars') and always say the currency the tool "
    "returned. Be honest when a tool fails. It is now "
    "{{telnyx_current_time_Asia/Jerusalem}} in Israel (weekday included; do "
    "not use UTC); use it to understand 'tomorrow', 'next Friday' or 'in two "
    "weeks' and to pass exact YYYY-MM-DD dates to tools."
)


# --------------------------------------------------------------- env helpers

def _req(env: dict[str, str], name: str) -> str:
    """Read a required value from the supplied env dict; raise a clear error."""
    val = env.get(name)
    if not val or not val.strip():
        raise c.ConfigError(f"missing required env var: {name}")
    return val.strip()


def _opt(env: dict[str, str], name: str, default: str) -> str:
    """Read an optional value from the env dict, or ``default``."""
    val = env.get(name)
    return val.strip() if val and val.strip() else default


def _int(env: dict[str, str], name: str, default: int) -> int:
    """Parse an int from the env dict; ``default`` if unset; ConfigError if bad."""
    val = env.get(name)
    if not val or not val.strip():
        return default
    try:
        return int(val.strip())
    except ValueError as e:
        raise c.ConfigError(f"{name}={val!r} is not an integer") from e


# --------------------------------------------------------------- assistant body

def assistant_body(env: dict[str, str], mcp_id: str,
                   conversation_timeout_secs: int | None = None) -> dict[str, Any]:
    """Build the assistant creation body from env vars and the flow module.

    ``mcp_id`` is the id of an MCP server already created with ``/ai/mcp_servers``;
    the assistant references it by id. Model, voice and the webhook URL are
    required and come from env vars; everything else has safe defaults so a
    ``--dry-run`` with just the required vars produces a complete body.

    ``insight_settings.insight_group_id`` references the "FlyTLV caller intent"
    insight group (created by ``_ensure_insight_group`` during provisioning).
    During ``--dry-run`` the id is whatever ``INSIGHT_GROUP_ID`` carries (empty
    by default) — the real provisioning step sets it before the body is built.
    """
    if conversation_timeout_secs is None:
        conversation_timeout_secs = _int(env, "CONVERSATION_TIMEOUT_SECS", 600)

    hangup_tool_id = env.get("HANGUP_TOOL_ID") or None
    transfer_from = _opt(env, "ASSISTANT_PHONE_NUMBER", "")
    transfer_to = _opt(env, "TRANSFER_TO_NUMBER", "")

    return {
        "insight_settings": {
            "insight_group_id": env.get("INSIGHT_GROUP_ID", ""),
        },
        "name": _opt(env, "ASSISTANT_NAME", "FlyTLV Travel Line"),
        "description": _opt(
            env, "ASSISTANT_DESCRIPTION",
            "FlyTLV Travel Line — cheap flights from Tel Aviv by phone, round trip or one way.",
        ),
        # Required by the CreateAssistant API.
        # Offer a human only when a transfer number (and so a transfer tool) exists.
        "instructions": BASE_INSTRUCTIONS + (
            f" If you cannot help, or the caller asks for a person, offer to transfer them to "
            f"{_opt(env, 'TRANSFER_TO_NAME', 'a human agent')} with the transfer tool." if transfer_to
            else " No human agent is available; if asked, say so and keep helping."),
        # Telnyx-hosted model id and voice — both from env (owner rule: nothing
        # hardcoded). Voice goes under voice_settings.voice per the API schema.
        "model": _req(env, "ASSISTANT_MODEL"),
        "voice_settings": {"voice": _req(env, "ASSISTANT_VOICE")},
        # Telephony must be enabled for the assistant to be callable by phone.
        "enabled_features": ["telephony"],
        # Dynamic variables: the Edge Function webhook resolves them at call
        # start; the defaults below keep expression edges safe if it fails.
        "dynamic_variables_webhook_url": _req(env, "WEBHOOK_URL"),
        # Telnyx recommends ~8 s for Edge Functions: a cold start can exceed 1.5 s.
        "dynamic_variables_webhook_timeout_ms": _int(env, "WEBHOOK_TIMEOUT_MS", 8000),
        "dynamic_variables": flow.DEFAULT_VARIABLES,
        # The MCP server supplies search_deals / save_deal / list_saved_deals / send_deal_sms.
        "mcp_servers": [{"id": mcp_id}],
        # Inline tools: hangup always, transfer only when a human is configured.
        # With a hangup tool node, no prompt node gets the hangup tool, so the
        # model cannot end the call mid-conversation (tools scoped per node).
        "tools": [t for t in flow.build_tools(transfer_from, transfer_to, _opt(env, "TRANSFER_TO_NAME", ""))
                  if not (hangup_tool_id and t["type"] == "hangup")],
        # The conversation workflow itself.
        "conversation_flow": _checked_flow(conversation_timeout_secs, hangup_tool_id),
    }


# -------------------------------------------------------------- provisioning
#
# The steps below call the official Telnyx SDK. They are orchestrated in order
# and each one is logged; a failure raises so the CLI exits non-zero (a partial
# provision is more confusing than a clear error). The phone-number link is the
# one soft step: Telnyx exposes the voice connection in the assistant record,
# and if it cannot be found automatically the number is left for a one-click
# link in the Portal rather than aborting an otherwise complete assistant.

async def _create_integration_secret(client: telnyx.AsyncTelnyx, env: dict[str, str]) -> str:
    """Store the MCP bearer token as an integration secret; return its identifier.

    The MCP server references this identifier as ``api_key_ref`` so Telnyx sends
    the token as a Bearer header to the MCP Edge Function on every tool call.
    """
    identifier = _opt(env, "MCP_API_KEY_REF", "flytlv-mcp-key")
    token = _req(env, "MCP_API_KEY")
    try:
        await client.integration_secrets.create(identifier=identifier, type="bearer", token=token)
        c.info("provision.integration_secret", identifier=identifier)
    except telnyx.UnprocessableEntityError as exc:
        # Re-running provisioning: the secret already exists, so reuse it.
        if "already in use" not in str(exc):
            raise
        c.warning("provision.integration_secret_exists", identifier=identifier)
    return identifier


async def _create_mcp_server(client: telnyx.AsyncTelnyx, env: dict[str, str],
                             api_key_ref: str) -> str:
    """Register the MCP server with Telnyx; return its id."""
    name = _opt(env, "MCP_SERVER_NAME", "flytlv-mcp")
    url = _req(env, "MCP_URL")
    server = await client.ai.mcp_servers.create(
        name=name,
        type="http",
        url=url,
        api_key_ref=api_key_ref,
    )
    c.info("provision.mcp_server", id=server.id, name=name, url=url)
    return server.id


async def _hangup_tool(client: telnyx.AsyncTelnyx, env: dict[str, str]) -> str:
    """The shared (org-level) hangup tool the End Call tool node runs: reuse
    HANGUP_TOOL_ID, else create it."""
    if env.get("HANGUP_TOOL_ID"):
        return env["HANGUP_TOOL_ID"]
    tool = await client.ai.tools.create(
        type="hangup",
        display_name=_opt(env, "HANGUP_TOOL_NAME", "flytlv-end-call"),
        extra_body={"hangup": {"description": "End the call after the farewell."}},
    )
    c.info("provision.hangup_tool", id=tool.id)
    return tool.id


# ------------------------------------------------------- conversation insights
#
# Telnyx keeps every assistant conversation and can run "insights" (LLM
# summaries derived from the transcript) on them. An assistant points at one
# "insight group"; the insights in that group run automatically for every
# conversation. Verified live 2026-10-08: `client.ai.conversations.insight_groups`
# and `client.ai.conversations.insights` (Telnyx SDK); the "Default" group only
# has a "Summary" insight, so we create a dedicated group with four custom
# caller-intent insights, reuse what already exists by name (re-runnable), and
# set the group id on `assistant_body().insight_settings`.
#
# SDK notes (verified in .venv):
#   - create group:  `insight_groups.insight_groups(*, name, ...)`  (yes, the
#     method is named the same as the resource) -> InsightTemplateGroupDetail.data.id
#   - list groups:    `insight_groups.retrieve_insight_groups(page_size=)` ->
#     AsyncPaginator[InsightTemplateGroup] (iterate with `async for`)
#   - create insight: `insights.create(*, name, instructions)` ->
#     InsightTemplateDetail.data.id
#   - list insights:  `insights.list(page_size=)` -> AsyncPaginator[InsightTemplate]
#   - assign to group: `insight_groups.insights.assign(insight_id, *, group_id=)`

def _insight_definitions() -> list[dict[str, str]]:
    """The four caller-intent insights (name + instructions).

    Each insight is an LLM prompt that runs against a conversation's transcript;
    the result is stored on the conversation and readable via the SDK for history
    (``scripts/ops/history.py``). Names are stable identifiers (not free text) so
    re-runs reuse the same insight instead of duplicating it.
    """
    return [
        {
            "name": "flytlv_destinations",
            "instructions": (
                "Extract the destination(s) the caller asked about during this "
                "conversation: the city and/or IATA code. Return 'none' if the "
                "caller did not name a destination. For multiple, list them."
            ),
        },
        {
            "name": "flytlv_dates_triptype",
            "instructions": (
                "Extract the travel dates the caller asked for (departure and "
                "return, or a one-way date) and the trip type (one_way or "
                "round_trip). Return 'flexible' for dates if the caller did not "
                "give a specific date."
            ),
        },
        {
            "name": "flytlv_deal_saved",
            "instructions": (
                "Did the caller save a deal? If so, return the destination (city), "
                "the price with currency, and the deal_id. Return 'no' if no deal "
                "was saved."
            ),
        },
        {
            "name": "flytlv_call_outcome",
            "instructions": (
                "Summarize the call outcome in one phrase: e.g. 'deal saved', "
                "'searched no save', 'transferred to human', 'caller ended', "
                "'no deals found'."
            ),
        },
    ]


async def _ensure_insight_group(client: telnyx.AsyncTelnyx, env: dict[str, str]) -> str:
    """Create (or reuse by name) the "FlyTLV caller intent" insight group with
    its four insights, and return the group id.

    Re-runnable: an existing group and insights are reused; an insight already
    assigned to the group is left as-is. Failures are logged and re-raised so
    an aborting provision is clear (same contract as the other steps).
    """
    group_name = _opt(env, "INSIGHT_GROUP_NAME", "FlyTLV caller intent")

    # Find an existing group by name (reuse on re-runs).
    group_id: str | None = None
    try:
        pager = client.ai.conversations.insight_groups.retrieve_insight_groups(
            page_size=100,
        )
        async for g in pager:
            if _get(g, "name") == group_name:
                group_id = _get(g, "id")
                break
    except telnyx.APIError as exc:
        c.error("provision.insight_group_list_failed", error=str(exc), exc_info=True)
        raise

    if group_id:
        c.info("provision.insight_group_reused", id=group_id, name=group_name)
    else:
        created = await client.ai.conversations.insight_groups.insight_groups(
            name=group_name,
        )
        group_id = _get(_get(created, "data"), "id")
        c.info("provision.insight_group_created", id=group_id, name=group_name)

    # Index existing insights by name so we reuse instead of duplicating.
    existing: dict[str, str] = {}
    try:
        ipager = client.ai.conversations.insights.list(page_size=100)
        async for ins in ipager:
            name = _get(ins, "name")
            if name:
                existing[name] = _get(ins, "id")
    except telnyx.APIError as exc:
        c.error("provision.insight_list_failed", error=str(exc), exc_info=True)
        raise

    for defn in _insight_definitions():
        ins_id = existing.get(defn["name"])
        if ins_id:
            c.info("provision.insight_reused", id=ins_id, name=defn["name"])
        else:
            created = await client.ai.conversations.insights.create(
                name=defn["name"], instructions=defn["instructions"],
            )
            ins_id = _get(_get(created, "data"), "id")
            c.info("provision.insight_created", id=ins_id, name=defn["name"])
        # Assign the insight into the group. Idempotent on re-runs: Telnyx returns
        # a 422 ("already assigned" style) when it is already a member — match the
        # same pattern as _create_integration_secret's "already in use" guard.
        try:
            await client.ai.conversations.insight_groups.insights.assign(
                ins_id, group_id=group_id,
            )
            c.info("provision.insight_assigned", insight=ins_id, group=group_id)
        except telnyx.UnprocessableEntityError as exc:
            if "already" not in str(exc).lower():
                raise
            c.warning("provision.insight_already_assigned", insight=ins_id, error=str(exc))

    return group_id


def _extract_connection_id(assistant: Any) -> str | None:
    """Best-effort read of a telephony connection id from an assistant record.

    Telnyx exposes the assistant's voice linkage inside ``telephony_settings``;
    the exact field name is read defensively (object attr or dict key) so the
    code does not break if the SDK model shape changes.
    """
    telephony = _get(assistant, "telephony_settings")
    for key in ("connection_id", "default_connection_id", "texml_app_id", "default_texml_app_id"):
        val = _get(telephony, key)  # works for the SDK model and a plain dict
        if val:
            return str(val)
    return _get(assistant, "connection_id") or None


def _get(obj: Any, key: str) -> Any:
    """Read a key from a SDK model object or a plain dict."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


async def _link_phone_number(client: telnyx.AsyncTelnyx, assistant_id: str,
                              env: dict[str, str]) -> str | None:
    """Point an owned phone number at the assistant's voice connection.

    ``ASSISTANT_PHONE_NUMBER_ID`` (or ``ASSISTANT_PHONE_NUMBER``) is the number
    id to link. The connection id comes from ``ASSISTANT_CONNECTION_ID`` if
    provided, otherwise it is read from the assistant record. If neither is
    available the number is left unlinked with a warning — the assistant is
    already fully created and the number can be linked from the Portal.
    """
    number_id = env.get("ASSISTANT_PHONE_NUMBER_ID") or env.get("ASSISTANT_PHONE_NUMBER")
    if not number_id:
        c.info("provision.phone_skipped", reason="ASSISTANT_PHONE_NUMBER_ID not set")
        return None

    connection_id = env.get("ASSISTANT_CONNECTION_ID")
    if not connection_id:
        assistant = await client.ai.assistants.retrieve(assistant_id)
        connection_id = _extract_connection_id(assistant)

    if not connection_id:
        c.warning(
            "provision.phone_link_manual",
            number=number_id,
            assistant=assistant_id,
            hint="Link this number to the assistant in the Telnyx Portal (AI Assistants).",
        )
        return None

    await client.phone_numbers.update(phone_number_id=number_id, connection_id=connection_id)
    c.info("provision.phone_linked", number=number_id, assistant=assistant_id)
    return number_id


async def provision(client: telnyx.AsyncTelnyx, env: dict[str, str]) -> Any:
    """Run the full provisioning sequence and return the created assistant.

    Creates the integration secret → MCP server → assistant, then links the
    phone number. Uses the SDK's async resources (``ai.assistants.create`` etc.).
    """
    secret_ref = await _create_integration_secret(client, env)
    # Re-running: reuse an already registered MCP server instead of adding another.
    mcp_id = env.get("MCP_SERVER_ID") or await _create_mcp_server(client, env, secret_ref)
    env.setdefault("HANGUP_TOOL_ID", await _hangup_tool(client, env))
    # The conversation insight group ("FlyTLV caller intent") whose insights run
    # for every conversation; its id is wired into assistant_body().insight_settings.
    env.setdefault("INSIGHT_GROUP_ID", await _ensure_insight_group(client, env))
    body = assistant_body(env, mcp_id)
    if env.get("ASSISTANT_ID"):
        # Re-running: update the existing assistant (same id, same phone link).
        assistant = await client.ai.assistants.update(env["ASSISTANT_ID"], **body)
    else:
        assistant = await client.ai.assistants.create(**body)
    c.info("provision.assistant", id=assistant.id, name=body["name"])
    await _link_phone_number(client, assistant.id, env)
    return assistant


# ----------------------------------------------------------------------- CLI

def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="provision",
        description="Provision the FlyTLV Travel Line AI assistant (Telnyx SDK).",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the assistant body that would be created and exit (no API calls).",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    # Local convenience: load the repo-root .env (without overriding anything
    # the shell already set). No-op on Telnyx Edge. Tests import this module
    # without calling main(), so this never runs during the test suite.
    c.load_env()
    env = dict(os.environ)

    if args.dry_run:
        # --dry-run does not call the SDK: emit the body so it can be reviewed
        # (and asserted on by the unit tests).
        timeout = _int(env, "CONVERSATION_TIMEOUT_SECS", 600)
        body = assistant_body(env, env.get("MCP_SERVER_ID", "mcp-server-id"), timeout)
        print(json.dumps(body, indent=2, sort_keys=True))
        return 0

    client = telnyx.AsyncTelnyx(api_key=c.require("TELNYX_API_KEY"))

    async def _run() -> None:
        try:
            await provision(client, env)
        finally:
            await client.close()

    asyncio.run(_run())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
