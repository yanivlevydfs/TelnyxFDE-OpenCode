"""services/mcp-server/function/func.py — MCP server for the FlyTLV Travel Line.

Three tools (registered on an `mcp` SDK 2.x ``MCPServer``) that the Telnyx AI
Assistant calls mid-conversation over stateless Streamable HTTP:

* ``search_deals``     — query the flytlv.app deals API (KV-cached), speak the
  best deals back, and remember them on the caller's Stateful Actor via
  ``setLastResults`` so a later ``save_deal`` can only save a deal the
  caller was actually offered (no invented prices or URLs).
* ``save_deal``        — save one of the last-shown deals to the caller's actor.
* ``list_saved_deals`` — read the deals the caller saved on previous calls.

Every value comes from an environment variable / Edge secret — nothing is
hardcoded. Bearer auth (``MCP_API_KEY``) is checked in ``Function.handle``
*before* the MCP session manager sees the request. Tool failures raise
``ToolError`` so the LLM receives ``isError: true`` and can recover gracefully.

Edge has no ASGI lifespan, so a stateless ``StreamableHTTPSessionManager`` is
created per request (verified SDK usage — see AGENTS.md). Telnyx sends the
conversation id in ``params._meta.telnyx_conversation_id``; each tool resolves
the caller from ``session/<conversation_id>`` in KV and forwards the same
``trace_id`` to the actor (configurable ``TRACE_HEADER``).

Run tests:  .venv/Scripts/python -m pytest UnitTest/test_mcp.py -q
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import telnyx
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

try:
    from . import common as c
    from . import flytlv
except ImportError:  # Edge loads func.py as a top-level module
    import common as c  # type: ignore[no-redef]
    import flytlv  # type: ignore[no-redef]


# ---------------------------------------------------------------- formatting

def slim(deal: dict, currency: str) -> dict:
    """Reduce a raw flytlv deal to the camelCase fields read aloud / shown.

    Only the voice-relevant fields survive; the raw payload is cached
    wholesale so a cache hit can re-slim without another upstream call.
    Missing fields default to ``None`` (flytlv omits e.g. ``is_direct`` /
    ``return_date`` on some deals) rather than raising.
    """
    dest = deal.get("destination_airport") or {}
    return {
        "dealId": deal.get("deal_id"),
        "city": dest.get("city"),
        "country": dest.get("country"),
        "price": deal.get("price"),
        "currency": currency,
        "departureDate": deal.get("departure_date"),
        "returnDate": deal.get("return_date"),
        "airline": deal.get("airline"),
        "direct": bool(deal.get("is_direct")),
        "url": deal.get("deal_url"),
    }


# ------------------------------------------------------------------ helpers

def _conversation_id(ctx: Context) -> str:
    """Pull the Telnyx conversation id from the request meta (per AGENTS.md)."""
    meta = getattr(getattr(ctx, "request_context", None), "meta", None) or {}
    return str(meta.get("telnyx_conversation_id") or "")


async def _best_effort_caller(kv: Any, conv_id: str) -> str | None:
    """Resolve the caller entity for a conversation, tolerating KV failure.

    Returns the entity id, or ``None`` if the session is unmapped/blank or KV
    is down. A missing link must not block the search itself — only the
    "remember results" step — so this never raises; it logs and degrades.
    """
    if not conv_id:
        return None
    prefix = c.optional("SESSION_KEY_PREFIX", "session/")
    try:
        session = await kv.get_json(f"{prefix}{conv_id}")
    except c.KvError as e:
        c.warning("mcp.session_read_failed", conversation=conv_id, error=str(e))
        return None
    if isinstance(session, dict) and session.get("entity_id"):
        return str(session["entity_id"])
    return None


async def _require_caller(kv: Any, conv_id: str) -> str:
    """Resolve the caller entity, raising ``ToolError`` on any failure.

    Used by tools that cannot work without a known caller (save / list). A
    missing mapping -> "identify this call"; an unreachable KV ->
    "unavailable".
    """
    if not conv_id:
        raise ToolError("I can't identify this call; please hang up and try again.")
    prefix = c.optional("SESSION_KEY_PREFIX", "session/")
    try:
        session = await kv.get_json(f"{prefix}{conv_id}")
    except c.KvError as e:
        c.error("mcp.session_read_failed", exc_info=True, conversation=conv_id, error=str(e))
        raise ToolError(
            "The session service is unavailable; please try again later."
        ) from e
    if not isinstance(session, dict) or not session.get("entity_id"):
        raise ToolError("I can't identify this call; please hang up and try again.")
    return str(session["entity_id"])


def _build_params(
    destination: str, direct_only: bool, max_price: int, departure_date: str
) -> dict[str, str]:
    """Canonical, string-only flytlv query params for a search."""
    params: dict[str, str] = {
        "sort": "cheapest",                    # cheapest first per the feed docs
        "one_per_destination": "true",          # at most one deal per city
        "limit": str(c.integer("DEALS_FETCH_LIMIT", 20)),
    }
    if destination and destination.strip():
        params["destination"] = destination.strip().upper()  # IATA code
    if direct_only:
        params["stops"] = "0"                    # direct flights only
    if max_price:
        params["max_price"] = str(max_price)
    if departure_date and departure_date.strip():
        params["departure_date"] = departure_date.strip()
    return params


def _cache_key(params: dict[str, str]) -> str:
    """Deterministic KV cache key for a deals query (prefix from env)."""
    prefix = c.optional("DEALS_CACHE_PREFIX", "cache/deals/")
    sig = "|".join(f"{k}={params[k]}" for k in sorted(params))
    return prefix + sig


# ------------------------------------------------------------------- server

def create_server(kv: Any, actor: Any, http: httpx.AsyncClient) -> MCPServer:
    """Build the ``MCPServer`` with the three tools, closing over dependencies.

    Dependencies (``kv``, ``actor``, ``http``) are injected so tests pass fakes;
    ``new()`` wires the real Telnyx clients in production.
    """
    server = MCPServer(c.optional("MCP_SERVER_NAME", "fde-mcp"))
    flytlv_client = flytlv.FlytlvClient(http)

    @server.tool()
    async def search_deals(
        ctx: Context,
        destination: str = "",
        direct_only: bool = False,
        max_price: int = 0,
        departure_date: str = "",
    ) -> str:
        """Search flytlv.app for cheap round-trip flight deals from Tel Aviv.

        Results are KV-cached (TTL ``DEALS_CACHE_TTL``) and remembered on the
        caller's actor via ``setLastResults`` so ``save_deal`` can only save a
        deal the caller was actually offered.
        """
        conv_id = _conversation_id(ctx)
        c.set_trace_id(conv_id or None)            # trace follows the conversation
        if not conv_id:
            raise ToolError("I can't identify this call; please hang up and try again.")
        entity_id = await _best_effort_caller(kv, conv_id)

        params = _build_params(destination, direct_only, max_price, departure_date)
        key = _cache_key(params)
        ttl = c.integer("DEALS_CACHE_TTL", 300)

        # Cache lookup — failure is non-fatal: fall through to flytlv.
        try:
            cached = await kv.get_json(key)
        except c.KvError as e:
            c.warning("mcp.cache_read_failed", key=key, error=str(e))
            cached = None

        if cached:
            payload = cached
            c.debug("mcp.cache_hit", key=key)
        else:
            try:
                payload = await flytlv_client.search(params)
            except flytlv.FlytlvError as e:
                raise ToolError(str(e)) from e
            try:                                   # cache write is best-effort
                await kv.put_json(key, payload, ttl_secs=ttl)
            except c.KvError as e:
                c.warning("mcp.cache_write_failed", key=key, error=str(e))

        currency = payload.get("currency", "") if isinstance(payload, dict) else ""
        deals = (payload.get("deals") if isinstance(payload, dict) else None) or []
        limit = c.integer("DEALS_RESULT_LIMIT", 5)
        slimmed = [slim(d, currency) for d in deals[:limit]]

        # Remember the deals shown on this caller's actor (decision #13).
        if not entity_id:
            raise ToolError(
                "I found deals but can't link them to your call; please try again."
            )
        try:
            await actor.call(entity_id, "setLastResults", {"deals": slimmed})
        except c.ActorInputError as e:
            raise ToolError(str(e)) from e
        except c.ActorError as e:
            c.error("mcp.remember_failed", exc_info=True, caller=entity_id)
            raise ToolError(
                "The session service is unavailable; please try again."
            ) from e

        c.info(
            "mcp.search_deals",
            caller=entity_id,
            deals=len(slimmed),
            destination=params.get("destination", ""),
            direct=direct_only,
        )
        return json.dumps({"deals": slimmed})

    @server.tool()
    async def save_deal(ctx: Context, deal_id: str) -> str:
        """Save one of the deals from the last search results to the caller's profile."""
        conv_id = _conversation_id(ctx)
        c.set_trace_id(conv_id or None)
        entity_id = await _require_caller(kv, conv_id)
        deal_id = (deal_id or "").strip()
        if not deal_id:
            raise ToolError("Please choose a deal to save first.")
        try:
            await actor.call(entity_id, "saveDeal", {"dealId": deal_id})
        except c.ActorInputError as e:
            raise ToolError(str(e)) from e
        except c.ActorError as e:
            c.error("mcp.save_failed", exc_info=True, caller=entity_id, deal=deal_id)
            raise ToolError(
                "The session service is unavailable; please try again."
            ) from e
        c.info("mcp.save_deal", caller=entity_id, deal=deal_id)
        return json.dumps({"saved": True, "dealId": deal_id})

    @server.tool()
    async def list_saved_deals(ctx: Context) -> str:
        """List the deals the caller has saved on previous calls."""
        conv_id = _conversation_id(ctx)
        c.set_trace_id(conv_id or None)
        entity_id = await _require_caller(kv, conv_id)
        try:
            profile = await actor.call(entity_id, "getSavedDeals")
        except c.ActorInputError as e:
            raise ToolError(str(e)) from e
        except c.ActorError as e:
            c.error("mcp.list_saved_failed", exc_info=True, caller=entity_id)
            raise ToolError(
                "The session service is unavailable; please try again."
            ) from e
        c.info("mcp.list_saved_deals", caller=entity_id)
        return json.dumps(profile)

    return server


# --------------------------------------------------------------- edge entry

def _get_header(scope: dict, name: str) -> str | None:
    """Read a header (case-insensitive) from an ASGI scope."""
    target = name.encode("latin-1").lower()
    for key, value in scope.get("headers", []):
        if key.lower() == target:
            return value.decode("latin-1")
    return None


async def _send_json(send, status: int, obj: dict) -> None:
    """Send a minimal JSON ASGI response (used for the 401 rejection)."""
    body = json.dumps(obj).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [[b"content-type", b"application/json"]],
        }
    )
    await send({"type": "http.response.body", "body": body})


class Function:
    """Edge contract: ``handle`` is the ASGI entry point the runtime calls."""

    def __init__(self, server: MCPServer) -> None:
        self._server = server
        # Bearer token expected on every request (MCP_API_KEY secret).
        self._expected_token = "Bearer " + c.optional("MCP_API_KEY", "")

    async def handle(self, scope: Any, receive: Any, send: Any) -> None:
        # Bearer auth FIRST — never let an unsigned request reach the manager.
        if scope.get("type") != "http":
            return
        auth = _get_header(scope, "authorization")
        if auth != self._expected_token:
            c.warning("mcp.unauthorized", reason="bearer mismatch")
            await _send_json(send, 401, {"error": "unauthorized"})
            return
        # Edge has no ASGI lifespan: a stateless session manager per request.
        manager = StreamableHTTPSessionManager(
            app=self._server._lowlevel_server, stateless=True, json_response=True
        )
        async with manager.run():
            await manager.handle_request(scope, receive, send)


def new() -> Function:
    """Production entry: build dependencies from env config (Edge secrets).

    Fails loudly on a missing required setting (``FLYTLV_API_KEY``,
    ``KV_NAMESPACE_ID``, ``ACTOR_SERVICE_URL``, ``INTERNAL_API_TOKEN``) so a
    broken deploy shows up at boot, not mid-call.
    """
    client = telnyx.AsyncTelnyx(api_key=os.environ.get("TELNYX_API_KEY") or None)
    kv = c.Kv(client)
    http = httpx.AsyncClient(timeout=c.integer("HTTP_TIMEOUT_MS", 3000) / 1000)
    actor = c.ActorClient(http)
    server = create_server(kv, actor, http)
    return Function(server=server)
