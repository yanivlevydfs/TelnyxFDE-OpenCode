"""Unit tests for shared/common.py — config, logging, Kv, ActorClient, sessions, phone.

Run:  .venv/Scripts/python -m pytest tests -q
"""

from __future__ import annotations

import json
import logging
import httpx
import pytest
import telnyx

import common as c  # shared/common.py (path set in conftest.py)


# ------------------------------------------------------------------ config

def test_require_returns_value_and_fails_fast(monkeypatch) -> None:
    monkeypatch.setenv("X_REQ", " value ")
    assert c.require("X_REQ") == "value"
    monkeypatch.delenv("X_REQ")
    with pytest.raises(c.ConfigError, match="X_REQ"):
        c.require("X_REQ")


def test_optional_integer_flag(monkeypatch) -> None:
    assert c.optional("X_MISSING", "dflt") == "dflt"
    monkeypatch.setenv("X_INT", "42")
    assert c.integer("X_INT", 1) == 42
    assert c.integer("X_MISSING", 7) == 7
    monkeypatch.setenv("X_INT", "abc")
    with pytest.raises(c.ConfigError):
        c.integer("X_INT", 1)
    monkeypatch.setenv("X_FLAG", "Yes")
    assert c.flag("X_FLAG") is True
    monkeypatch.setenv("X_FLAG", "off")
    assert c.flag("X_FLAG", default=True) is False


# ----------------------------------------------------------------- logging

def _lines(capsys) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line]


def test_log_lines_are_json_with_level_and_trace(capsys) -> None:
    c.set_trace_id("trace-1")
    c.info("hello", n=1)
    c.warning("careful")
    line_info, line_warn = _lines(capsys)
    assert line_info["level"] == "INFO" and line_info["event"] == "hello" and line_info["n"] == 1
    assert line_info["trace_id"] == "trace-1"
    assert line_warn["level"] == "WARNING"


def test_error_includes_traceback(capsys) -> None:
    try:
        raise RuntimeError("boom")
    except RuntimeError:
        c.error("failed", exc_info=True)
    (line,) = _lines(capsys)
    assert line["level"] == "ERROR" and "RuntimeError: boom" in line["exception"]


def test_timed_logs_duration_and_errors(capsys) -> None:
    with c.timed("work") as span:
        span["items"] = 3
    with pytest.raises(ValueError):
        with c.timed("broken"):
            raise ValueError("x")
    ok, bad = _lines(capsys)
    assert ok["span"] == "work" and ok["items"] == 3 and "duration_ms" in ok
    assert bad["level"] == "ERROR" and bad["outcome"] == "error"


def test_log_level_filter() -> None:
    c.logger.setLevel(logging.WARNING)
    try:
        assert not c.logger.isEnabledFor(logging.INFO)
    finally:
        c.logger.setLevel(logging.INFO)


def test_set_trace_id_generates_when_missing() -> None:
    assert len(c.set_trace_id(None)) == 32


# ---------------------------------------------------------------------- KV

class _FakeResp:
    def __init__(self, raw: bytes) -> None:
        self._raw = raw

    async def read(self) -> bytes:
        return self._raw


class _FakeKeys:
    """Stands in for client.storage.kvs.keys."""

    def __init__(self, store: dict, fail: Exception | None = None) -> None:
        self.store, self.fail, self.ttls = store, fail, {}

    async def retrieve(self, key, *, id):
        if self.fail:
            raise self.fail
        if key not in self.store:
            raise telnyx.NotFoundError("missing", response=httpx.Response(404, request=httpx.Request("GET", "http://x")), body=None)
        return _FakeResp(self.store[key])

    async def update(self, key, body, *, id, **kwargs):
        if self.fail:
            raise self.fail
        self.store[key] = body
        self.ttls[key] = kwargs.get("ttl_secs")


def _kv(monkeypatch, keys: _FakeKeys) -> c.Kv:
    monkeypatch.setenv("KV_NAMESPACE_ID", "ns-1")
    client = type("C", (), {})()
    client.storage = type("S", (), {})()
    client.storage.kvs = type("K", (), {"keys": keys})()
    return c.Kv(client)


@pytest.mark.asyncio
async def test_kv_roundtrip_and_missing(monkeypatch) -> None:
    keys = _FakeKeys({})
    kv = _kv(monkeypatch, keys)
    assert await kv.get_json("nope") is None
    await kv.put_json("a", {"x": 1}, ttl_secs=60)
    assert await kv.get_json("a") == {"x": 1}
    assert keys.ttls["a"] == 60


@pytest.mark.asyncio
async def test_kv_errors_become_kverror(monkeypatch) -> None:
    kv = _kv(monkeypatch, _FakeKeys({"bad": b"not json"}))
    with pytest.raises(c.KvError):
        await kv.get_json("bad")
    err = telnyx.APIConnectionError(request=httpx.Request("GET", "http://x"))
    kv = _kv(monkeypatch, _FakeKeys({}, fail=err))
    with pytest.raises(c.KvError):
        await kv.get_json("a")
    with pytest.raises(c.KvError):
        await kv.put_json("a", 1)


# ------------------------------------------------------------- actor client

def _actor(monkeypatch, handler) -> c.ActorClient:
    monkeypatch.setenv("ACTOR_SERVICE_URL", "https://actor.test/")
    monkeypatch.setenv("INTERNAL_API_TOKEN", "tok")
    return c.ActorClient(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


@pytest.mark.asyncio
async def test_actor_call_sends_auth_trace_and_returns_json(monkeypatch) -> None:
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(url=str(request.url), auth=request.headers["authorization"],
                    trace=request.headers["x-trace-id"], body=json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    c.set_trace_id("t-9")
    out = await _actor(monkeypatch, handler).call("97250", "saveDeal", {"dealId": "d1"})
    assert out == {"ok": True}
    assert seen == {"url": "https://actor.test/actors/97250/saveDeal", "auth": "Bearer tok",
                    "trace": "t-9", "body": {"dealId": "d1"}}


@pytest.mark.asyncio
async def test_actor_errors(monkeypatch) -> None:
    rejecting = _actor(monkeypatch, lambda r: httpx.Response(400, json={"error": "deal not found"}))
    with pytest.raises(c.ActorInputError, match="deal not found"):
        await rejecting.call("1", "saveDeal")
    failing = _actor(monkeypatch, lambda r: httpx.Response(500, json={"error": "x"}))
    with pytest.raises(c.ActorError):
        await failing.call("1", "saveDeal")

    def down(request):
        raise httpx.ConnectError("down")
    with pytest.raises(c.ActorError):
        await _actor(monkeypatch, down).call("1", "saveDeal")


# ---------------------------------------------------------------- sessions

class _MemKv:
    def __init__(self) -> None:
        self.data, self.ttl = {}, {}

    async def get_json(self, key):
        return self.data.get(key)

    async def put_json(self, key, value, ttl_secs=None):
        self.data[key], self.ttl[key] = value, ttl_secs


@pytest.mark.asyncio
async def test_sessions_save_and_load() -> None:
    kv = _MemKv()
    await c.save_session(kv, "conv-1", "97250")
    assert kv.ttl["session/conv-1"] == 3600
    assert await c.load_session(kv, "conv-1") == "97250"
    assert await c.load_session(kv, "unknown") is None
    assert await c.load_session(kv, "") is None


# ------------------------------------------------------------------- phone

def test_phone_helpers() -> None:
    assert c.entity_id("+972-50-123 4567") == "972501234567"
    assert c.entity_id("") == ""
    assert c.mask("+13125550100") == "***0100"
    assert c.mask("") == ""
