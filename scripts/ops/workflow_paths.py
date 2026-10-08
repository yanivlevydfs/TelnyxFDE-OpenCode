"""scripts/ops/workflow_paths.py — walk every Conversation Workflow path.

Creates ONE throwaway copy of the assistant (same workflow, tools and MCP
server), drives it through the Telnyx chat API path by path, checks each reply,
then deletes the copy and the TeXML application Telnyx created for it (deleting
an assistant does not delete that app, and the account has a small cap).

Before creating the copy it sweeps any leftover " (path test)" assistants and
their TeXML apps from a crashed or killed prior run, and the ``finally`` cleanup
runs each call in its own try/except so one failing call (e.g. ``retrieve``)
never leaves a copy behind.

Fallback paths are forced through the copy's default dynamic variables
(backend_degraded, flag_deals_enabled). The chat channel does call the
dynamic-variables webhook (as caller +10000000001), so these runs show up in the
webhook metrics.

    python scripts/ops/workflow_paths.py

Needs the provisioning values in .env (TELNYX_API_KEY, MCP_SERVER_ID, ...).
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path
from typing import Any

import telnyx

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "shared"), str(ROOT / "assistant")]
import common as c  # shared JSON logger: info / debug / warning / error
import flow
import provision

# Local convenience: load the repo-root .env (without overriding anything the
# shell already set). No-op on Telnyx Edge — this file never runs there.
c.load_env()

E = dict(os.environ)


async def chat(client: telnyx.AsyncTelnyx, assistant_id: str, messages: list[str]) -> list[str]:
    """One fresh conversation; returns the assistant's reply to each message."""
    conv = await client.ai.conversations.create(metadata={"telnyx_end_user_target": "+10000000001"})
    data: Any = getattr(conv, "data", None) or conv
    conv_id = data["id"] if isinstance(data, dict) else data.id
    replies = []
    for m in messages:
        r = await client.ai.assistants.chat(assistant_id, content=m, conversation_id=str(conv_id), timeout=120)
        replies.append(str(getattr(r, "content", r)))
    return replies


def any_word(text: str, *words: str) -> bool:
    return any(w in text.lower() for w in words)


# (path, default-variable overrides, conversation timeout secs, messages, check on the replies)
SCENARIOS = [
    ("greeting: speak node, verbatim disclosure", {}, 600, ["Hi"],
     lambda r: flow.GREETING_MESSAGE in r[0]),
    ("FAQ: booking", {}, 600, ["Hi", "How do I book a flight with you?"],
     lambda r: any_word(r[1], "link", "flytlv") and not any_word(r[1], "with the airline")),
    ("FAQ: departure cities", {}, 600, ["Hi", "Can I fly from Eilat or Haifa?"],
     lambda r: any_word(r[1], "tel aviv", "ben gurion")),
    ("FAQ: discount meaning", {}, 600, ["Hi", "What does the discount mean?"],
     lambda r: any_word(r[1], "usual", "typical", "normal")),
    ("FAQ: not covered (baggage)", {}, 600, ["Hi", "Is a suitcase included?"],
     lambda r: any_word(r[1], "airline", "flytlv") and not any_word(r[1], "usually", "typically")),
    ("FAQ: saved deals", {}, 600, ["Hi", "If I save a deal, will you remember it next time I call?"],
     lambda r: any_word(r[1], "number", "next call", "call again", "phone", "remember", "next time")),
    ("search: holiday (category)", {}, 600, ["Hi", "Any cheap deals for Hanukkah?"],
     lambda r: any_word(r[1], "hanukkah", "chanukah") and any_word(r[1], "dollar", "$")),
    ("search: one way", {}, 600, ["Hi", "A one way flight to anywhere, the cheapest"],
     lambda r: any_word(r[1], "one way", "one-way")),
    ("search: happy path", {}, 600, ["Hi", "The cheapest flights to Athens, any date"],
     lambda r: any_word(r[1], "athens")),
    ("search: negative, no such place", {}, 600, ["Hi", "Cheap flights to Narnia please"],
     lambda r: any_word(r[1], "narnia") and not any_word(r[1], "dollar")),
    ("save: negative, hidden caller id", {}, 600,
     ["Hi", "The cheapest flights to Athens, any date", "Save the first one"],
     lambda r: any_word(r[2], "can't", "cannot", "unable", "not able", "hidden", "isn't possible", "identify")),
    # Over chat the transfer cannot connect; the check is that the agent offers it.
    ("human: offers the transfer", {}, 600, ["Hi", "I want to speak to a human"],
     lambda r: any_word(r[1], "transfer", "connect")),
    ("goodbye: speak node, verbatim farewell", {}, 600, ["Hi", "That's all, thanks, bye"],
     lambda r: flow.FAREWELL_MESSAGE in r[1]),
    ("fallback: backend degraded (expression edge)", {"backend_degraded": "true"}, 600, ["Hi", "Find flights"],
     lambda r: any(flow.DEGRADED_MESSAGE in x for x in r)),
    ("fallback: deals disabled by KV flag (expression edge)", {"flag_deals_enabled": "false"}, 600,
     ["Hi", "Find flights"],
     lambda r: any(flow.DISABLED_MESSAGE in x for x in r)),
]
# Not testable over chat: the timeout edge reads telnyx_conversation_duration_secs,
# a system variable only set on phone calls, so a real call covers it.


async def _delete_assistant_and_texml(client: telnyx.AsyncTelnyx, assistant_id: str) -> str | None:
    """Best-effort deletion of one assistant and the TeXML app Telnyx made for it.

    Each call runs in its own try/except and logs ERROR with a traceback on
    failure, so a failing ``retrieve`` no longer skips the deletes after it
    (the live bug that left a " (path test)" assistant on the account). Returns
    the TeXML app id it tried to delete (or None).
    """
    texml_id = None
    try:
        texml_id = provision._extract_connection_id(await client.ai.assistants.retrieve(assistant_id))
    except Exception:  # noqa: BLE001 (cleanup must keep going; log and continue)
        c.error("path.retrieve_failed", exc_info=True, assistant_id=assistant_id)
    try:
        await client.ai.assistants.delete(assistant_id)
    except Exception:  # noqa: BLE001
        c.error("path.assistant_delete_failed", exc_info=True, assistant_id=assistant_id)
    if texml_id:
        try:
            await client.texml_applications.delete(texml_id)
        except Exception:  # noqa: BLE001
            c.error("path.texml_delete_failed", exc_info=True, texml_id=texml_id)
    return texml_id


async def _sweep_leftovers(client: telnyx.AsyncTelnyx) -> None:
    """Delete leftover " (path test)" assistants and their TeXML apps before
    creating a fresh copy. A crashed or killed prior run leaves these behind,
    and the account caps the number of assistants and TeXML apps. Never touches
    an assistant whose name does not end with " (path test)".
    """
    listed = await client.ai.assistants.list()
    for a in listed.data:
        name = provision._get(a, "name") or ""
        if not name.endswith(" (path test)"):
            continue
        aid = provision._get(a, "id")
        texml_id = await _delete_assistant_and_texml(client, aid)
        c.warning("path.leftover_removed", assistant_id=aid, name=name, texml_id=texml_id)


async def main() -> int:
    client = telnyx.AsyncTelnyx(api_key=E["TELNYX_API_KEY"])
    await _sweep_leftovers(client)
    body = provision.assistant_body(E, E["MCP_SERVER_ID"])
    body["name"] = f"{body['name']} (path test)"
    test = await client.ai.assistants.create(**body)
    failures = 0
    try:
        for name, overrides, timeout, messages, ok in SCENARIOS:
            await client.ai.assistants.update(
                test.id,
                dynamic_variables={**flow.DEFAULT_VARIABLES, **overrides},
                conversation_flow=provision.assistant_body(E, E["MCP_SERVER_ID"], timeout)["conversation_flow"],
            )
            try:
                replies = await chat(client, test.id, messages)
                passed = bool(ok(replies))
            except Exception as e:  # noqa: BLE001 (report every path, keep going)
                replies, passed = [f"error: {e}"], False
            failures += not passed
            (c.info if passed else c.error)(
                "path.pass" if passed else "path.fail", path=name,
                turns=[{"caller": m, "assistant": r[:300]} for m, r in zip(messages, replies)])
    finally:
        # Each cleanup call in its own try/except (see _delete_assistant_and_texml):
        # one failing call must not skip the deletes after it.
        await _delete_assistant_and_texml(client, test.id)
        try:
            await client.close()
        except Exception:  # noqa: BLE001
            c.error("path.close_failed", exc_info=True)
    (c.error if failures else c.info)("path.summary", passed=len(SCENARIOS) - failures, total=len(SCENARIOS))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
