"""Unit tests for the Dynamic Variables webhook.

Run:  .venv/Scripts/python -m pytest tests -q
"""

from __future__ import annotations

import asyncio
import base64
import json
import time

import pytest
from conftest import load_service
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from starlette.testclient import TestClient

func = load_service("webhook", "webhook_fn")

EVENT = {"data": {"event_type": "assistant.initialization", "payload": {
    "telnyx_end_user_target": "+972501234567", "telnyx_conversation_id": "conv-1"}}}


class FakeClient:
    """Stands in for telnyx.AsyncTelnyx: only webhooks.unwrap is used."""

    def __init__(self, valid: bool = True) -> None:
        self.webhooks = self
        self.valid = valid

    def unwrap(self, payload, *, headers):
        if not self.valid:
            raise ValueError("bad signature")  # the real SDK raises a ValueError subclass
        return {}


class FakeKv:
    def __init__(self, flags=None, fail=False) -> None:
        self.flags, self.fail, self.saved = flags or {}, fail, {}

    async def get_json(self, key):
        if self.fail:
            raise RuntimeError("kv down")
        return self.flags

    async def put_json(self, key, value, ttl_secs=None):
        if self.fail:
            raise RuntimeError("kv down")
        self.saved[key] = value


class FakeActor:
    def __init__(self, profile=None, fail=False, slow=False) -> None:
        self.profile, self.fail, self.slow, self.calls = profile or {}, fail, slow, []

    async def call(self, entity, method, payload=None):
        self.calls.append((entity, method))
        if self.slow:
            await asyncio.sleep(5)
        if self.fail:
            raise RuntimeError("actor down")
        return self.profile


def post(client, kv, actor, body=EVENT, method="post"):
    app = func.create_app(client, kv, actor)
    with TestClient(app) as http:
        return getattr(http, method)("/", content=json.dumps(body) if body is not None else None)


def test_happy_path_returns_personal_variables() -> None:
    kv = FakeKv(flags={"deals_enabled": True, "promo": "summer", "nested": {"x": 1}})
    actor = FakeActor({"callCount": 3, "savedCount": 1, "lastSaved": {
        "city": "Larnaca", "price": 64.0, "currency": "USD"}})
    resp = post(FakeClient(), kv, actor)
    assert resp.status_code == 200
    assert resp.json()["dynamic_variables"] == {
        "caller_known": "true", "call_count": "3", "saved_count": "1",
        "last_saved_deal": "Larnaca, 64 USD", "backend_degraded": "false",
        "flag_deals_enabled": "true", "flag_promo": "summer"}
    assert actor.calls == [("972501234567", "recordCall")]
    assert kv.saved["session/conv-1"] == {"entity_id": "972501234567"}


def test_bad_signature_is_401() -> None:
    assert post(FakeClient(valid=False), FakeKv(), FakeActor()).status_code == 401


def test_invalid_json_is_400(monkeypatch) -> None:
    app = func.create_app(FakeClient(), FakeKv(), FakeActor())
    with TestClient(app) as http:
        assert http.post("/", content="{not json").status_code == 400


def test_get_is_405() -> None:
    app = func.create_app(FakeClient(), FakeKv(), FakeActor())
    with TestClient(app) as http:
        assert http.get("/").status_code == 405


def test_dependency_failure_degrades_to_defaults() -> None:
    resp = post(FakeClient(), FakeKv(fail=True), FakeActor(fail=True))
    v = resp.json()["dynamic_variables"]
    assert resp.status_code == 200
    assert v["backend_degraded"] == "true" and v["call_count"] == "0" and v["caller_known"] == "false"


def test_slow_dependency_hits_budget() -> None:
    start = time.perf_counter()
    resp = post(FakeClient(), FakeKv(), FakeActor(slow=True))
    assert time.perf_counter() - start < 2
    assert resp.json()["dynamic_variables"]["backend_degraded"] == "true"


def test_anonymous_caller_skips_actor() -> None:
    actor = FakeActor()
    body = {"data": {"payload": {"telnyx_conversation_id": "conv-2"}}}
    resp = post(FakeClient(), FakeKv(), actor, body=body)
    assert resp.status_code == 200 and actor.calls == []


def test_real_sdk_verifies_telnyx_signature(monkeypatch) -> None:
    """The real Telnyx SDK accepts a correctly signed assistant.initialization event."""
    import telnyx
    key = Ed25519PrivateKey.generate()
    public = base64.b64encode(key.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw)).decode()
    client = telnyx.AsyncTelnyx(api_key="test", public_key=public)
    body = json.dumps(EVENT)
    ts = str(int(time.time()))
    sig = base64.b64encode(key.sign(f"{ts}|{body}".encode())).decode()
    app = func.create_app(client, FakeKv(), FakeActor({"callCount": 1}))
    with TestClient(app) as http:
        good = http.post("/", content=body, headers={"telnyx-signature-ed25519": sig, "telnyx-timestamp": ts})
        bad = http.post("/", content=body, headers={"telnyx-signature-ed25519": sig, "telnyx-timestamp": "1"})
    assert good.status_code == 200
    assert bad.status_code == 401


def test_new_fails_loudly_without_config(monkeypatch) -> None:
    for name in ("KV_NAMESPACE_ID", "ACTOR_SERVICE_URL", "INTERNAL_API_TOKEN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TELNYX_API_KEY", "x")
    with pytest.raises(Exception, match="missing required env var"):
        func.new()
