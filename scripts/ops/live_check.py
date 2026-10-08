"""scripts/ops/live_check.py — end-to-end check of the deployed Telnyx Edge services.

Runs real requests against the live webhook, MCP server and actor, then prints
PASS/FAIL per check. Uses fresh test caller ids, never a real caller.

    python scripts/ops/live_check.py

Needs the .env values (WEBHOOK_URL, MCP_URL, MCP_API_KEY, ACTOR_SERVICE_URL,
INTERNAL_API_TOKEN, TELNYX_API_KEY, KV_NAMESPACE_ID).
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import sys
import time
from pathlib import Path

import httpx
import telnyx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))  # scripts/ops/ -> repo root
import common as c

# Local convenience: load the repo-root .env (without overriding anything the
# shell already set). No-op on Telnyx Edge — this file never runs there.
c.load_env()

E = os.environ
results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    (c.info if ok else c.error)("check.pass" if ok else "check.fail", check=name, detail=detail)


def mcp(conv: str, tool: str, args: dict | None = None) -> tuple[bool, str]:
    """Call one MCP tool; return (is_error, text)."""
    r = httpx.post(E["MCP_URL"], timeout=60, headers={
        "Authorization": f"Bearer {E['MCP_API_KEY']}", "accept": "application/json, text/event-stream",
    }, json={"jsonrpc": "2.0", "id": 1, "method": "tools/call",
             "params": {"name": tool, "arguments": args or {}, "_meta": {"telnyx_conversation_id": conv}}})
    res = r.json()["result"]
    return bool(res.get("isError")), res["content"][0]["text"]


def actor(path: str, body: dict | None = None) -> httpx.Response:
    return httpx.post(f"{E['ACTOR_SERVICE_URL'].rstrip('/')}{path}", timeout=60,
                      headers={"Authorization": f"Bearer {E['INTERNAL_API_TOKEN']}"}, json=body or {})


def kv(op):
    """Run one KV operation (Telnyx SDK, async) with a fresh client."""
    async def run():
        async with telnyx.AsyncTelnyx(api_key=E["TELNYX_API_KEY"]) as client:
            return await op(c.Kv(client))
    return asyncio.run(run())


async def concurrent_record_calls(n: int) -> list[int]:
    """n concurrent recordCall requests to one fresh caller actor."""
    who = f"1999{random.randint(10**6, 10**7)}"
    async with httpx.AsyncClient(timeout=60) as h:
        rs = await asyncio.gather(*[h.post(f"{E['ACTOR_SERVICE_URL'].rstrip('/')}/actors/{who}/recordCall",
                                           headers={"Authorization": f"Bearer {E['INTERNAL_API_TOKEN']}"}, json={})
                                    for _ in range(n)])
    return sorted(r.json()["callCount"] for r in rs)


def main() -> int:
    flags_key = E.get("KV_FLAGS_KEY", "flags/assistant")
    flags = kv(lambda k: k.get_json(flags_key)) or {}
    conv, entity = f"live-check-{random.randint(10**5, 10**6)}", f"1888{random.randint(10**6, 10**7)}"
    kv(lambda k: k.put_json(f"session/{conv}", {"entity_id": entity}, ttl_secs=1800))
    greece: list[dict] = []

    # Security
    r = httpx.post(E["WEBHOOK_URL"], content="{}", timeout=30)
    check("webhook rejects unsigned requests", r.status_code == 401, str(r.status_code))
    r = httpx.post(f"{E['ACTOR_SERVICE_URL'].rstrip('/')}/actors/%E0/getProfile", content="{}", timeout=30)
    check("actor: bad path without token is 401, no crash", r.status_code == 401, str(r.status_code))
    r = httpx.post(E["MCP_URL"], content="{}", timeout=30)
    check("MCP rejects requests without the key", r.status_code == 401, str(r.status_code))

    # MCP tools
    r = httpx.post(E["MCP_URL"], timeout=30, headers={
        "Authorization": f"Bearer {E['MCP_API_KEY']}", "accept": "application/json, text/event-stream",
    }, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = sorted(t["name"] for t in r.json()["result"]["tools"])
    check("MCP has 4 tools", tools == ["list_saved_deals", "save_deal", "search_deals", "send_deal_sms"], str(tools))

    actor("/metrics/reset")
    for label, args in [("anywhere", {}), ("next weekend", {"weekend": "upcoming"}), ("Greece", {"country": "Greece"})]:
        err, text = mcp(conv, "search_deals", args)
        deals = [] if err else json.loads(text)["deals"]
        detail = text[:80] if err else ", ".join(f"{d['city']} {d['price']}" for d in deals[:3])
        check(f"search {label}", not err and len(deals) > 0, detail)
        if label == "Greece":
            check("Greece search returns only Greece", all(d["country"] == "Greece" for d in deals))
            check("deals carry airports, times, flight numbers",
                  all(d.get("toAirport") and d.get("outbound", {}).get("departs") for d in deals))
            greece = deals
    err, _ = mcp(conv, "search_deals", {"country": "Greece"})  # same query again -> cache
    err, text = mcp(conv, "search_deals", {"destination": "not-a-code"})
    check("invalid tool input is rejected", err, text[:80])

    for d in greece[:2]:
        err, text = mcp(conv, "save_deal", {"deal_id": d["dealId"]})
        check(f"save {d['dealId']}", not err, text[:60])
    err, text = mcp(conv, "list_saved_deals")
    saved = 0 if err else json.loads(text).get("savedCount", 0)
    check("list shows both saved deals", saved >= 2, f"savedCount {saved}")
    err, text = mcp(conv, "save_deal", {"deal_id": "nope"})
    check("bad save explains why, no phone number", err and "last search" in text and entity not in text, text[:60])

    # Hidden caller id: deals are read, nothing remembered
    err, text = mcp(f"no-session-{conv}", "search_deals", {})
    check("hidden caller id still gets deals", not err and "note" in json.loads(text), text[:60])

    # SMS kill switch (KV flag) without sending a message
    kv(lambda k: k.put_json(flags_key, {**flags, "sms_enabled": False}))
    err, text = mcp(conv, "send_deal_sms", {"deal_id": greece[0]["dealId"]})
    check("sms_enabled=false blocks SMS in code", err and "turned off" in text, text[:60])
    kv(lambda k: k.put_json(flags_key, flags or {"deals_enabled": True, "sms_enabled": True, "promo": ""}))

    # Actor: concurrent read-modify-write
    counts = asyncio.run(concurrent_record_calls(20))
    check("actor: 20 concurrent recordCall, no lost updates", counts == list(range(1, 21)))

    # Metrics actor
    time.sleep(3)  # metrics are sent after each response
    snap = actor("/metrics/snapshot").json()
    cnt = snap.get("counts", {})
    check("metrics: tool calls counted", cnt.get("mcp.tool_calls", 0) >= 8, str(cnt.get("mcp.tool_calls")))
    check("metrics: KV cache hit recorded", cnt.get("cache.hit", 0) >= 1, f"hit {cnt.get('cache.hit')} miss {cnt.get('cache.miss')}")
    check("metrics: latency recorded", "tool.search_deals" in snap.get("latency", {}))

    failed = [n for n, ok, _ in results if not ok]
    (c.error if failed else c.info)("check.summary", passed=len(results) - len(failed), total=len(results), failed=failed)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
