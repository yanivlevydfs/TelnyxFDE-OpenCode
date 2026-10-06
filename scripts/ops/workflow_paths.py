"""scripts/ops/workflow_paths.py — walk every Conversation Workflow path.

Creates ONE throwaway copy of the assistant (same workflow, tools and MCP
server), drives it through the Telnyx chat API path by path, checks each reply,
then deletes the copy and the TeXML application Telnyx created for it (deleting
an assistant does not delete that app, and the account has a small cap).

Fallback paths are forced through the copy's default dynamic variables
(backend_degraded, flag_deals_enabled) and a zero-second conversation timeout;
the chat channel does not call the dynamic-variables webhook.

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
     lambda r: any_word(r[1], "link", "text", "flytlv")),
    ("FAQ: departure cities", {}, 600, ["Hi", "Can I fly from Eilat or Haifa?"],
     lambda r: any_word(r[1], "tel aviv", "ben gurion")),
    ("FAQ: discount meaning", {}, 600, ["Hi", "What does the discount mean?"],
     lambda r: any_word(r[1], "usual", "typical", "normal")),
    ("FAQ: not covered (baggage)", {}, 600, ["Hi", "Is a suitcase included?"],
     lambda r: any_word(r[1], "airline", "flytlv")),
    ("FAQ: saved deals", {}, 600, ["Hi", "Do you remember the deals I save?"],
     lambda r: any_word(r[1], "number", "next call", "call again", "phone")),
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
     lambda r: any_word(r[2], "can't", "cannot", "unable", "not able", "hidden", "isn't possible")),
    ("human: none configured, keeps helping", {}, 600, ["Hi", "I want to speak to a human"],
     lambda r: any_word(r[1], "no human", "not available", "isn't available", "unavailable")),
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


async def main() -> int:
    client = telnyx.AsyncTelnyx(api_key=E["TELNYX_API_KEY"])
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
        texml_id = provision._extract_connection_id(await client.ai.assistants.retrieve(test.id))
        await client.ai.assistants.delete(test.id)
        if texml_id:  # the app Telnyx created for THIS test copy only
            await client.texml_applications.delete(texml_id)
        await client.close()
    (c.error if failures else c.info)("path.summary", passed=len(SCENARIOS) - failures, total=len(SCENARIOS))
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
