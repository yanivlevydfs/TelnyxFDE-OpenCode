"""services/webhook/function/func.py — Dynamic Variables webhook.

Telnyx POSTs ``assistant.initialization`` here once at call start. We verify
the Ed25519 signature, then — in parallel, under ``WEBHOOK_BUDGET_MS`` — read
feature flags from KV, record the call on the caller's Stateful Actor, and map
the conversation id to the caller in KV (so the MCP server can find the caller
from ``telnyx_conversation_id``). The reply is flat string-only
``dynamic_variables`` the workflow uses for greetings and expression-edge
routing. Any failure or timeout degrades to safe defaults with
``backend_degraded="true"`` instead of leaving raw ``{{placeholders}}`` on air.

Run tests:  .venv/Scripts/python -m pytest UnitTest/test_webhook.py -q
"""

from __future__ import annotations

import asyncio
import inspect
import json
import os
import time
from collections.abc import Mapping
from typing import Any

import httpx
import telnyx
from starlette.applications import Starlette
from starlette.background import BackgroundTask
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route
from telnyx.lib.webhook_verification import WebhookVerificationError

try:
    from . import common as c  # normal: part of the `function` package
except ImportError:  # Edge loads func.py as a top-level module
    import common as c  # type: ignore[no-redef]


# ----------------------------------------------------------------- signature

async def _valid_signature(client: Any, body: bytes, headers: Mapping[str, str]) -> bool:
    """Verify the Telnyx Ed25519 signature (and timestamp replay window).

    ``AsyncTelnyx.webhooks.unwrap`` is async and raises
    ``WebhookVerificationError``; fakes used in tests are sync and raise
    ``ValueError``. Both spellings are handled here.
    """
    try:
        result = client.webhooks.unwrap(body.decode("utf-8"), headers=headers)
        if inspect.isawaitable(result):
            await result
    except (ValueError, WebhookVerificationError):
        return False
    return True


# -------------------------------------------------------------- dependencies

async def _fetch_context(kv: Any, actor: Any, entity: str, conversation_id: str) -> tuple[dict, dict, list[str]]:
    """Run flags-get, actor ``recordCall`` and the session mapping in parallel.

    Returns ``(flags, profile, degraded)`` where ``degraded`` is the list of
    dependency names that failed or timed out (empty = fully healthy).
    The whole batch is bounded by WEBHOOK_BUDGET_MS (well under Telnyx's
    default dynamic-variables timeout of 1.5 s).
    """
    flags_key = c.optional("KV_FLAGS_KEY", "flags/assistant")
    session_prefix = c.optional("SESSION_KEY_PREFIX", "session/")
    budget = c.integer("WEBHOOK_BUDGET_MS", 1200) / 1000

    names: list[str] = ["flags"]
    calls = [kv.get_json(flags_key)]
    if entity:  # anonymous/blocked caller: skip the actor and the mapping
        names.append("profile")
        calls.append(actor.call(entity, "recordCall"))
        if conversation_id:
            names.append("session")
            calls.append(kv.put_json(
                f"{session_prefix}{conversation_id}", {"entity_id": entity},
                ttl_secs=c.integer("SESSION_TTL", 3600)))

    # Bound the batch by the budget but keep whatever finished in time:
    # a slow actor must not discard flags that already arrived.
    tasks = [asyncio.ensure_future(call) for call in calls]
    done, pending = await asyncio.wait(tasks, timeout=budget)
    for task in pending:
        task.cancel()
    results: list[Any] = [
        (t.exception() or t.result()) if t in done
        else asyncio.TimeoutError(f"dependency budget exceeded ({budget}s)")
        for t in tasks
    ]

    out: dict[str, Any] = dict(zip(names, results))
    failed = [name for name, result in out.items() if isinstance(result, BaseException)]
    for name in failed:
        c.error("webhook.dependency_failed", dependency=name, error=str(out[name]))
    # Only the actor and the session mapping break the call (the MCP tools need
    # both); a failed flags read just falls back to default flags.
    degraded = [name for name in failed if name != "flags"]

    flags = out.get("flags")
    profile = out.get("profile")
    return (
        flags if isinstance(flags, dict) else {},
        profile if isinstance(profile, dict) else {},
        degraded,
    )


# ---------------------------------------------------------------- formatting

def _last_saved_deal(profile: dict) -> str:
    """"Larnaca, 64 USD" from the actor's lastSaved deal ('' when absent)."""
    deal = profile.get("lastSaved")
    if not isinstance(deal, dict):
        return ""
    price = deal.get("price")
    amount = f"{price:g} {deal.get('currency', '')}".strip() if isinstance(price, (int, float)) else ""
    return ", ".join(part for part in (deal.get("city", ""), amount) if part)


def _flag_vars(flags: dict) -> dict[str, str]:
    """Scalar KV flags as ``flag_<name>`` variables (string values only)."""
    out: dict[str, str] = {}
    for name, value in flags.items():
        if isinstance(value, bool):
            out[f"flag_{name}"] = "true" if value else "false"
        elif isinstance(value, (int, float, str)):
            out[f"flag_{name}"] = str(value)
        # nested values are skipped: dynamic variables are flat strings
    return out


def _dynamic_variables(profile: dict, flags: dict, degraded: bool) -> dict[str, str]:
    """The flat string-only variable set returned to Telnyx."""
    return {
        # Known = called before (recordCall already counted this call).
        "caller_known": "true" if profile.get("callCount", 0) > 1 else "false",
        "call_count": str(profile.get("callCount", 0)),
        "saved_count": str(profile.get("savedCount", 0)),
        "last_saved_deal": _last_saved_deal(profile),
        "backend_degraded": "true" if degraded else "false",
        **_flag_vars(flags),
    }


# ---------------------------------------------------------------------- app

def create_app(client: Any, kv: Any, actor: Any, *, verify: bool = True) -> Starlette:
    """Build the ASGI app with injected dependencies (tests pass fakes)."""

    async def handle(request: Request) -> JSONResponse:
        started = time.perf_counter()
        counts: dict[str, float] = {"webhook.calls": 1}
        resp = await _handle(request, counts)
        # Service metrics go to the shared MetricsCounter actor AFTER the response
        # is sent, so they never eat into the dynamic-variables time budget.
        record = getattr(actor, "metrics", None)
        if record is not None:
            ms = round((time.perf_counter() - started) * 1000)
            resp.background = BackgroundTask(record, counts, {"webhook.request": ms})
        return resp

    async def _handle(request: Request, counts: dict[str, float]) -> JSONResponse:
        body = await request.body()
        with c.timed("webhook.request") as span:
            # Signature first: an unsigned body is never even parsed.
            if verify and not await _valid_signature(client, body, request.headers):
                span["outcome"] = "rejected"
                c.warning("webhook.rejected", reason="signature")
                counts["webhook.rejected"] = 1
                return JSONResponse({"error": "invalid signature"}, status_code=401)
            try:
                event = json.loads(body)
            except ValueError:  # JSONDecodeError + UnicodeDecodeError
                span["outcome"] = "rejected"
                c.warning("webhook.rejected", reason="json")
                counts["webhook.rejected"] = 1
                return JSONResponse({"error": "invalid json"}, status_code=400)

            data = event.get("data") if isinstance(event, dict) else {}
            payload = data.get("payload", {}) if isinstance(data, dict) else {}
            if not isinstance(payload, dict):
                payload = {}
            phone = str(payload.get("telnyx_end_user_target") or "")
            # The MCP server finds the caller by telnyx_conversation_id, so only that
            # id keys the session; call_control_id is a fallback for the trace only.
            conversation_id = str(payload.get("telnyx_conversation_id") or "")
            c.set_trace_id(conversation_id or str(payload.get("call_control_id") or "") or None)
            entity = c.entity_id(phone)  # digits only, '' for anonymous callers
            # Only an E.164 caller id is an identity (and an SMS destination): a
            # national number or SIP URI would collide or text the wrong number.
            if not (phone.strip().startswith("+") and 8 <= len(entity) <= 15):
                entity = ""

            flags, profile, degraded = await _fetch_context(kv, actor, entity, conversation_id)
            span["outcome"] = "degraded" if degraded else "ok"
            span["caller"] = c.mask(phone)
            span["degraded"] = degraded
            if not entity:
                counts["callers.anonymous"] = 1
            elif profile:  # only when the actor answered; otherwise unknown
                counts["callers.returning" if profile.get("callCount", 0) > 1 else "callers.new"] = 1
            if degraded:
                counts["webhook.degraded"] = 1
                for name in degraded:
                    counts[f"webhook.failed.{name}"] = 1
            c.info("webhook.variables", caller=c.mask(phone), degraded=degraded)
            return JSONResponse({"dynamic_variables": _dynamic_variables(profile, flags, bool(degraded))})

    return Starlette(routes=[Route("/", handle, methods=["POST"])])


# --------------------------------------------------------------- edge entry

class Function:
    """Edge contract: ``handle`` is the ASGI entry point the runtime calls."""

    def __init__(self, app: Starlette) -> None:
        self._app = app

    async def handle(self, scope: Any, receive: Any, send: Any) -> None:
        await self._app(scope, receive, send)


def new() -> Function:
    """Production entry: build the app from env config (Edge secrets).

    Fails loudly on a missing required setting (TELNYX_API_KEY,
    KV_NAMESPACE_ID, ACTOR_SERVICE_URL, INTERNAL_API_TOKEN) so a broken
    deploy shows up at boot, not mid-call.
    """
    client = telnyx.AsyncTelnyx(public_key=os.environ.get("TELNYX_PUBLIC_KEY") or None)
    kv = c.Kv(client)
    http = httpx.AsyncClient(timeout=c.integer("HTTP_TIMEOUT_MS", 1000) / 1000)
    actor = c.ActorClient(http)
    return Function(create_app(client, kv, actor, verify=c.flag("WEBHOOK_VERIFY_SIGNATURE", True)))
