"""Unit tests for the MCP server: auth, tools/list, and each tool's success + error paths.

Run:  .venv/Scripts/python -m pytest UnitTest -q
"""

from __future__ import annotations

import json

import httpx
import pytest

from conftest import load_service

func = load_service("mcp-server", "mcp_fn")
c = func.c  # the service's own copy of common.py

FLYTLV = {"currency": "USD", "count": 3, "deals": [
    {"deal_id": "tlv-lca-1", "price": 64.0, "departure_date": "2026-11-09", "return_date": "2026-11-12",
     "airline": "Wizz Air", "is_direct": True, "deal_url": "https://flytlv.app/go?id=tlv-lca-1",
     "destination_airport": {"city": "Larnaca", "country": "Cyprus"}},
    {"deal_id": "tlv-pmo-1", "price": 90.0, "destination_airport": {"city": "Palermo", "country": "Italy"}},
    {"deal_id": "extra", "price": 120.0, "destination_airport": {"city": "Athens"}},
]}


class FakeKv:
    def __init__(self, mapped=True, fail=False) -> None:
        self.data = {"session/conv-1": {"entity_id": "97250"}} if mapped else {}
        self.fail = fail

    async def get_json(self, key):
        if self.fail:
            raise c.KvError("down")
        return self.data.get(key)

    async def put_json(self, key, value, ttl_secs=None):
        if self.fail:
            raise c.KvError("down")
        self.data[key] = value


class FakeActor:
    def __init__(self, reject: str | None = None, fail=False) -> None:
        self.calls, self.reject, self.fail = [], reject, fail

    async def call(self, entity, method, payload=None):
        self.calls.append((entity, method, payload))
        if self.reject:
            raise c.ActorInputError(self.reject)
        if self.fail:
            raise c.ActorError("down")
        return {"method": method, "ok": True}


def flytlv_http(status=200, calls=None):
    def handler(request: httpx.Request) -> httpx.Response:
        if calls is not None:
            calls.append(request)
        return httpx.Response(status, json=FLYTLV if status == 200 else {"detail": "Not Found"})
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def rpc(kv, actor, http, method, params=None, token="mcp-test"):
    fn = func.Function(server=func.create_server(kv, actor, http))
    headers = {"accept": "application/json, text/event-stream", "authorization": f"Bearer {token}"}
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=fn.handle), base_url="http://x") as cl:
        return await cl.post("/", json=body, headers=headers)


def tool_call(name, args=None, conversation="conv-1"):
    return {"name": name, "arguments": args or {}, "_meta": {"telnyx_conversation_id": conversation}}


def result(resp) -> dict:
    out = resp.json()["result"]
    return {"error": out["isError"], "text": out["content"][0]["text"]}


@pytest.mark.asyncio
async def test_wrong_token_is_401() -> None:
    resp = await rpc(FakeKv(), FakeActor(), flytlv_http(), "tools/list", token="nope")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_tools_list_has_three_tools() -> None:
    resp = await rpc(FakeKv(), FakeActor(), flytlv_http(), "tools/list")
    names = {t["name"] for t in resp.json()["result"]["tools"]}
    assert names == {"search_deals", "save_deal", "list_saved_deals"}


@pytest.mark.asyncio
async def test_search_deals_calls_flytlv_caches_and_remembers() -> None:
    kv, actor, calls = FakeKv(), FakeActor(), []
    resp = await rpc(kv, actor, flytlv_http(calls=calls), "tools/call",
                     tool_call("search_deals", {"destination": "lca", "direct_only": True}))
    out = result(resp)
    assert not out["error"]
    deals = json.loads(out["text"])["deals"]
    assert [d["city"] for d in deals] == ["Larnaca", "Palermo"]  # DEALS_RESULT_LIMIT=2
    req = calls[0]
    assert req.headers["x-api-key"] == "flytlv-test"
    assert req.url.params["destination"] == "LCA" and req.url.params["stops"] == "0"
    assert any(k.startswith("cache/deals/") for k in kv.data)
    assert actor.calls[0][:2] == ("97250", "setLastResults")


@pytest.mark.asyncio
async def test_search_deals_uses_cache_on_second_call() -> None:
    kv, calls = FakeKv(), []
    http = flytlv_http(calls=calls)
    await rpc(kv, FakeActor(), http, "tools/call", tool_call("search_deals", {"destination": "LCA"}))
    await rpc(kv, FakeActor(), http, "tools/call", tool_call("search_deals", {"destination": "LCA"}))
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_search_deals_flytlv_failure_is_tool_error() -> None:
    resp = await rpc(FakeKv(), FakeActor(), flytlv_http(status=404), "tools/call", tool_call("search_deals"))
    out = result(resp)
    assert out["error"] and "unavailable" in out["text"]


@pytest.mark.asyncio
async def test_search_deals_works_without_kv_cache() -> None:
    """KV down: flytlv still answers, but remembering results fails -> clear tool error."""
    resp = await rpc(FakeKv(fail=True), FakeActor(), flytlv_http(), "tools/call", tool_call("search_deals"))
    assert result(resp)["error"]


@pytest.mark.asyncio
async def test_save_deal_success_and_rejection() -> None:
    ok = await rpc(FakeKv(), FakeActor(), flytlv_http(), "tools/call", tool_call("save_deal", {"deal_id": "tlv-lca-1"}))
    assert not result(ok)["error"]
    rejected = await rpc(FakeKv(), FakeActor(reject="deal not in the last search results"),
                         flytlv_http(), "tools/call", tool_call("save_deal", {"deal_id": "x"}))
    out = result(rejected)
    assert out["error"] and "last search" in out["text"]


@pytest.mark.asyncio
async def test_unknown_conversation_is_tool_error() -> None:
    resp = await rpc(FakeKv(mapped=False), FakeActor(), flytlv_http(), "tools/call",
                     tool_call("list_saved_deals", conversation="other"))
    out = result(resp)
    assert out["error"] and "identify this call" in out["text"]


@pytest.mark.asyncio
async def test_actor_down_is_tool_error() -> None:
    resp = await rpc(FakeKv(), FakeActor(fail=True), flytlv_http(), "tools/call", tool_call("list_saved_deals"))
    out = result(resp)
    assert out["error"] and "unavailable" in out["text"]


def test_slim_keeps_voice_fields() -> None:
    assert func.slim(FLYTLV["deals"][0], "USD") == {
        "dealId": "tlv-lca-1", "city": "Larnaca", "country": "Cyprus", "price": 64.0, "currency": "USD",
        "departureDate": "2026-11-09", "returnDate": "2026-11-12", "airline": "Wizz Air",
        "direct": True, "url": "https://flytlv.app/go?id=tlv-lca-1"}
