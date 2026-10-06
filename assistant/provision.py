"""assistant/provision.py — provision the FlyTLV Travel Line assistant.

A small CLI that builds the assistant definition and creates it through the
official Telnyx Python SDK. In order it provisions:

1. an **integration secret** holding the MCP server bearer token (``MCP_API_KEY``),
2. an **MCP server** (``/ai/mcp_servers``) pointing at the deployed MCP Edge
   Function, authenticated with the secret above so Telnyx sends the bearer
   token on every tool call,
3. the **AI assistant** (``/ai/assistants``) with the conversation workflow,
   dynamic variables webhook, MCP server reference and tools built by
   ``assistant/flow.py``,
4. links a **phone number** to the assistant so the line is callable.

Every URL, id, model and voice comes from environment variables / Telnyx Edge
secrets — nothing is hardcoded. ``--dry-run`` skips all API calls and prints
the assistant body that *would* be created, which is what the unit test uses.

Run tests:  .venv/Scripts/python -m pytest UnitTest/test_assistant.py -q
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

import common as c  # noqa: E402  (structured logging + config helpers)
import flow  # noqa: E402  (graph, tools and default variables)


# ------------------------------------------------------------- base prompt
#
# The assistant-level instructions. Prompt-node instructions ``append`` to this,
# so it carries the global policy: identity, data integrity (no invented
# prices), voice conciseness and a currency rule. Dynamic-variable placeholders
# are interpolated by Telnyx at call time.

BASE_INSTRUCTIONS = (
    "You are the FlyTLV Travel Line voice assistant. You help people find cheap "
    "round-trip flights from Tel Aviv over the phone, using tools for all flight "
    "data — you never invent prices, dates, airlines, cities or booking URLs. "
    "Keep responses short and spoken-friendly; spell amounts naturally (for "
    "example 'sixty-four dollars'). Prices are in {{currency}} when the tool "
    "gives a currency. Be honest when a tool fails, and offer to transfer the "
    "caller to a human if you cannot help."
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
    """
    if conversation_timeout_secs is None:
        conversation_timeout_secs = _int(env, "CONVERSATION_TIMEOUT_SECS", 300)

    transfer_from = _opt(env, "ASSISTANT_PHONE_NUMBER", "")
    transfer_to = _opt(env, "TRANSFER_TO_NUMBER", "")

    return {
        "name": _opt(env, "ASSISTANT_NAME", "FlyTLV Travel Line"),
        "description": _opt(
            env, "ASSISTANT_DESCRIPTION",
            "FlyTLV Travel Line — cheap round-trip flights from Tel Aviv by phone.",
        ),
        # Required by the CreateAssistant API.
        "instructions": BASE_INSTRUCTIONS,
        # Telnyx-hosted model id and voice — both from env (owner rule: nothing
        # hardcoded). Voice goes under voice_settings.voice per the API schema.
        "model": _req(env, "ASSISTANT_MODEL"),
        "voice_settings": {"voice": _req(env, "ASSISTANT_VOICE")},
        # Telephony must be enabled for the assistant to be callable by phone.
        "enabled_features": ["telephony"],
        # Dynamic variables: the Edge Function webhook resolves them at call
        # start; the defaults below keep expression edges safe if it fails.
        "dynamic_variables_webhook_url": _req(env, "WEBHOOK_URL"),
        "dynamic_variables_webhook_timeout_ms": _int(env, "WEBHOOK_TIMEOUT_MS", 1500),
        "dynamic_variables": flow.DEFAULT_VARIABLES,
        # The MCP server supplies search_deals / save_deal / list_saved_deals.
        "mcp_servers": [{"id": mcp_id}],
        # Inline tools: hangup always, transfer only when a human is configured.
        "tools": flow.build_tools(transfer_from, transfer_to),
        # The conversation workflow itself.
        "conversation_flow": flow.build_flow(conversation_timeout_secs),
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
    await client.integration_secrets.create(identifier=identifier, type="token", token=token)
    c.info("provision.integration_secret", identifier=identifier)
    return identifier


async def _create_mcp_server(client: telnyx.AsyncTelnyx, env: dict[str, str],
                             api_key_ref: str) -> str:
    """Register the MCP server with Telnyx; return its id."""
    name = _opt(env, "MCP_SERVER_NAME", "flytlv-mcp")
    url = _req(env, "MCP_URL")
    server = await client.ai.mcp_servers.create(
        name=name,
        type="streamable_http",
        url=url,
        api_key_ref=api_key_ref,
    )
    c.info("provision.mcp_server", id=server.id, name=name, url=url)
    return server.id


def _extract_connection_id(assistant: Any) -> str | None:
    """Best-effort read of a telephony connection id from an assistant record.

    Telnyx exposes the assistant's voice linkage inside ``telephony_settings``;
    the exact field name is read defensively (object attr or dict key) so the
    code does not break if the SDK model shape changes.
    """
    telephony = _get(assistant, "telephony_settings")
    if isinstance(telephony, dict):
        for key in ("connection_id", "default_connection_id", "texml_app_id", "default_texml_app_id"):
            val = telephony.get(key)
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
    mcp_id = await _create_mcp_server(client, env, secret_ref)
    body = assistant_body(env, mcp_id)
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
    env = dict(os.environ)

    if args.dry_run:
        # --dry-run does not call the SDK: emit the body so it can be reviewed
        # (and asserted on by the unit tests).
        timeout = _int(env, "CONVERSATION_TIMEOUT_SECS", 300)
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
