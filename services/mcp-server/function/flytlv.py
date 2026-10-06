"""services/mcp-server/function/flytlv.py — minimal flytlv.app deals API client.

Production knowledge reused from the read-only ``reference/flytlv_app``
(``client.py`` + ``config.py``) — the owner's existing flytlv.app client:

* base URL from ``FLYTLV_API_BASE`` (default ``https://flytlv.app``);
* the deals endpoint is ``/api/private/deals`` (``DEALS_ENDPOINT`` in the
  reference config) — overridable via ``FLYTLV_DEALS_PATH``;
* the ``X-API-Key`` header carries ``FLYTLV_API_KEY`` (header name overridable
  via ``FLYTLV_API_KEY_HEADER``, default ``X-API-Key``);
* the feed is **fail-closed**: a 404 means the key is unset/rejected or the
  feed is off — a configuration state, not a transient error — so we log it
  once at ERROR and tell the caller the deals service is unavailable instead
  of retry-storming (mirrors the reference's "log once" behaviour);
* timeouts are short (a live phone caller cannot wait the reference's 60 s
  background-refresh timeout) and configurable via ``FLYTLV_TIMEOUT_MS``.

Only what a single ``search_deals`` tool call needs lives here. There is no
background pool, refresh thread, rate spacing, cooldown or 429 backoff: those
belong to the flytlv.app side, not this stateless Edge Function. A failure is
turned into a ``FlytlvError`` whose message is safe to surface verbatim as an
MCP ``ToolError`` (never leaks the URL, the key or a traceback).
"""

from __future__ import annotations

from typing import Any

import httpx

try:
    from . import common as c
except ImportError:  # Edge loads func.py as a top-level module
    import common as c  # type: ignore[no-redef]


class FlytlvError(Exception):
    """The flytlv.deals API cannot be used right now.

    The message is caller-friendly and safe to surface verbatim as a
    ``ToolError`` — it never leaks the upstream URL, the API key or a
    traceback to the caller.
    """


# Log the fail-closed 404 once per process instance. Edge scales to zero, so
# "once" is best-effort within one instance; a fresh instance will log again.
_off_logged = False


def _log_feed_off_once() -> None:
    """Log the fail-closed 404 at ERROR level once per process instance."""
    global _off_logged
    if _off_logged:
        return
    c.error(
        "flytlv.feed_off",
        status=404,
        reason="404 fail-closed: X-API-Key unset/rejected or feed switched off",
    )
    _off_logged = True


class FlytlvClient:
    """Stateless async client for one authenticated ``GET /api/private/deals``."""

    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._base = c.optional("FLYTLV_API_BASE", "https://flytlv.app").rstrip("/")
        self._path = c.optional("FLYTLV_DEALS_PATH", "/api/private/deals")
        self._key = c.require("FLYTLV_API_KEY")
        self._header = c.optional("FLYTLV_API_KEY_HEADER", "X-API-Key")
        # Short by default: a phone caller is on the line. Configurable up.
        self._timeout = c.integer("FLYTLV_TIMEOUT_MS", 3000) / 1000

    async def search(self, params: dict[str, Any]) -> dict:
        """One authenticated GET; returns the parsed payload or raises FlytlvError.

        ``params`` is forwarded as URL query params; ``None`` values are dropped
        so callers can pass optional filters through unchanged.
        """
        query = {k: str(v) for k, v in params.items() if v is not None}
        url = self._base + self._path
        headers = {self._header: self._key}
        try:
            resp = await self._http.get(
                url, params=query, headers=headers, timeout=self._timeout
            )
        except httpx.TimeoutException as e:
            c.warning("flytlv.timeout", error=str(e))
            raise FlytlvError(
                "The deals service is taking too long to respond; please try again shortly."
            ) from e
        except httpx.HTTPError as e:
            c.error("flytlv.request_failed", exc_info=True, error=f"{type(e).__name__}: {e}")
            raise FlytlvError(
                "The deals service is temporarily unavailable; please try again."
            ) from e

        if resp.status_code == 404:
            # Fail-closed feed: key unset/rejected or feed switched off.
            _log_feed_off_once()
            raise FlytlvError(
                "The deals service is unavailable right now. Please try again later."
            )

        if resp.status_code == 429:
            c.warning("flytlv.rate_limited")
            raise FlytlvError(
                "The deals service is busy right now; please try again shortly."
            )

        if resp.status_code >= 400:
            c.error("flytlv.http_error", status=resp.status_code)
            raise FlytlvError(
                "The deals service is unavailable right now. Please try again later."
            )

        try:
            payload = resp.json()
        except ValueError as e:
            c.error("flytlv.bad_json", exc_info=True)
            raise FlytlvError("The deals service returned an unreadable response.") from e

        if not isinstance(payload, dict):
            c.error("flytlv.unexpected_shape", type=type(payload).__name__)
            raise FlytlvError("The deals service returned an unexpected response.")
        return payload
