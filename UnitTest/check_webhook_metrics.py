"""Self-check: the webhook reports metrics to the shared actor after responding.

Run: .venv/Scripts/python UnitTest/check_webhook_metrics.py
"""
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "UnitTest"))
for k, v in {"ACTOR_SERVICE_URL": "https://actor.test", "INTERNAL_API_TOKEN": "t",
             "KV_NAMESPACE_ID": "ns", "TELNYX_PUBLIC_KEY": "k"}.items():
    os.environ.setdefault(k, v)

from conftest import load_service  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

func = load_service("webhook", "webhook_fn")


class Kv:
    async def get_json(self, key):
        return {"deals_enabled": True}

    async def put_json(self, key, value, ttl_secs=None):
        return None


class Actor:
    def __init__(self):
        self.sent = []

    async def call(self, entity, method, body=None):
        return {"callCount": 3, "savedCount": 1, "lastSaved": None}

    async def metrics(self, counts, latency=None):
        self.sent.append((counts, latency))


actor = Actor()
app = func.create_app(object(), Kv(), actor, verify=False)
body = {"data": {"payload": {"telnyx_end_user_target": "+972501234567", "telnyx_conversation_id": "c1"}}}
with TestClient(app) as http:
    assert http.post("/", content=json.dumps(body)).status_code == 200
    assert http.post("/", content="{bad").status_code == 400
(ok_counts, ok_lat), (bad_counts, _) = actor.sent
assert ok_counts == {"webhook.calls": 1, "callers.returning": 1}, ok_counts
assert set(ok_lat) == {"webhook.request"}
assert bad_counts == {"webhook.calls": 1, "webhook.rejected": 1}, bad_counts
print("webhook metrics check OK")
