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
from typing import Any, Mapping

import httpx
import telnyx
from starlette.applications import Starlette
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

    try:
        results = await asyncio.wait_for(asyncio.gather(*calls, return_exceptions=True), timeout=budget)
    except TimeoutError:  # budget hit: every outstanding call counts as failed
        results = [TimeoutError(f"dependency budget exceeded ({budget}s)") for _ in calls]

    out: dict[str, Any] = dict(zip(names, results))
    degraded = [name for name, result in out.items() if isinstance(result, BaseException)]
    for name in degraded:
        c.error("webhook.dependency_failed", dependency=name, error=str(out[name]))

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
        "caller_known": "true" if profile else "false",
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
        body = await request.body()
        with c.timed("webhook.request") as span:
            # Signature first: an unsigned body is never even parsed.
            if verify and not await _valid_signature(client, body, request.headers):
                span["outcome"] = "rejected"
                c.warning("webhook.rejected", reason="signature")
                return JSONResponse({"error": "invalid signature"}, status_code=401)
            try:
                event = json.loads(body)
            except ValueError:  # JSONDecodeError + UnicodeDecodeError
                span["outcome"] = "rejected"
                c.warning("webhook.rejected", reason="json")
                return JSONResponse({"error": "invalid json"}, status_code=400)

            data = event.get("data") if isinstance(event, dict) else {}
            payload = data.get("payload", {}) if isinstance(data, dict) else {}
            if not isinstance(payload, dict):
                payload = {}
            phone = str(payload.get("telnyx_end_user_target") or "")
            conversation_id = str(payload.get("telnyx_conversation_id") or payload.get("call_control_id") or "")
            c.set_trace_id(conversation_id or None)  # trace follows the conversation
            entity = c.entity_id(phone)  # digits only, '' for anonymous callers

            flags, profile, degraded = await _fetch_context(kv, actor, entity, conversation_id)
            span["outcome"] = "degraded" if degraded else "ok"
            span["caller"] = c.mask(phone)
            span["degraded"] = degraded
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
