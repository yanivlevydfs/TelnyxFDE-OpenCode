"""shared/common.py — config, JSON logging, Kv, ActorClient, sessions, phone.

Single source of truth for Python code reused across the Edge Function services
(webhook, mcp-server). `scripts/vendor_shared.py` copies this file into each
service as `function/common.py` so the Edge build picks it up. Keep it one file,
no imports of repo-local modules — only the stdlib, httpx and telnyx.

Run tests:  .venv/Scripts/python -m pytest UnitTest/test_common.py -q
"""

from __future__ import annotations

import json
import logging
import os
import re
import time
import uuid
from contextlib import contextmanager
from typing import Any

import httpx
import telnyx

# --------------------------------------------------------------------- config

class ConfigError(ValueError):
    """Raised when a required env var is missing or fails to parse."""


def require(name: str) -> str:
    """Return a required, stripped env var. Raise ConfigError if unset."""
    val = os.environ.get(name)
    if val is None:
        raise ConfigError(f"missing required env var: {name}")
    return val.strip()


def optional(name: str, default: str) -> str:
    """Return a stripped env var, or `default` if unset."""
    val = os.environ.get(name)
    return val.strip() if val is not None else default


def integer(name: str, default: int) -> int:
    """Parse an int env var. `default` if unset. ConfigError if unparseable."""
    val = os.environ.get(name)
    if val is None:
        return default
    try:
        return int(val.strip())
    except ValueError:
        raise ConfigError(f"{name}={val!r} is not an integer")


_TRUE_VALUES = {"yes", "on", "true", "1"}


def flag(name: str, default: bool = False) -> bool:
    """Parse a boolean flag (yes/on/true/1 → True). `default` if unset."""
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in _TRUE_VALUES


# -------------------------------------------------------------------- logging

# Per-process trace id; flows into every log line and outbound request header.
_trace_id: str = uuid.uuid4().hex


def set_trace_id(tid: str | None) -> str:
    """Set the current trace id; generate a 32-hex one if None. Returns it.

    The id is mirrored onto the shared ``"common"`` logger object (one singleton
    for every vendored copy of this file) so that the ``_JsonFormatter`` another
    copy installed reads the latest value instead of a stale module global.
    """
    global _trace_id
    _trace_id = tid or uuid.uuid4().hex
    logger._trace_id = _trace_id
    return _trace_id


class _JsonFormatter(logging.Formatter):
    """One JSON object per log line: level, event, trace_id, fields, exception."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "level": record.levelname,
            "event": record.getMessage(),
            # Read from the shared logger so a set_trace_id in any vendored copy
            # is visible to the formatter installed by whichever copy ran first.
            "trace_id": getattr(logger, "_trace_id", _trace_id),
        }
        if hasattr(record, "fields"):
            payload.update(record.fields)
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload)


class _StdoutHandler(logging.Handler):
    """Writes via print() so pytest's capsys (which patches sys.stdout at call
    time, after we built this logger) captures the lines."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            print(self.format(record))
        except Exception:
            self.handleError(record)


logger = logging.getLogger("common")
# Log level from the LOG_LEVEL env var (default INFO); unknown names -> INFO.
logger.setLevel(getattr(logging, os.environ.get("LOG_LEVEL", "INFO").upper(), logging.INFO))
# Don't double-add if this module is re-imported in the same process. Compare
# by class NAME: vendored copies of this file (webhook_fn.common, ...) are
# distinct classes but must share one stdout handler on the "common" logger.
if not any(h.__class__.__name__ == "_StdoutHandler" for h in logger.handlers):
    _handler = _StdoutHandler()
    _handler.setFormatter(_JsonFormatter())
    logger.addHandler(_handler)
logger.propagate = False  # never bubble up to the root logger
# Initialise the shared trace id once (first importer wins; set_trace_id updates
# it thereafter). Lives on the logger object so every vendored copy shares it.
if not hasattr(logger, "_trace_id"):
    logger._trace_id = _trace_id


def info(event: str, **fields: Any) -> None:
    """INFO line. Keyword args become JSON fields."""
    logger.info(event, extra={"fields": fields})


def warning(event: str, **fields: Any) -> None:
    """WARNING line. Keyword args become JSON fields."""
    logger.warning(event, extra={"fields": fields})


def error(event: str, *, exc_info: bool = False, **fields: Any) -> None:
    """ERROR line. Pass exc_info=True to append a traceback."""
    logger.error(event, exc_info=exc_info, extra={"fields": fields})


def debug(event: str, **fields: Any) -> None:
    """DEBUG line. Keyword args become JSON fields (emitted only at DEBUG level)."""
    logger.debug(event, extra={"fields": fields})


@contextmanager
def timed(span: str):
    """Time a block. Yields a dict; anything the caller puts in it is merged
    into the success log line. On exception, logs ERROR and re-raises."""
    start = time.perf_counter()
    data: dict[str, Any] = {}
    try:
        yield data
    except BaseException:
        ms = int((time.perf_counter() - start) * 1000)
        error(span, exc_info=True, span=span, duration_ms=ms, outcome="error")
        raise
    else:
        ms = int((time.perf_counter() - start) * 1000)
        fields = dict(data)
        fields["span"] = span
        fields["duration_ms"] = ms
        info(span, **fields)


# -------------------------------------------------------------------- KV

class KvError(Exception):
    """Any KV access failure (bad JSON, API error, network error)."""


class Kv:
    """Async JSON wrapper over telnyx.storage.kvs.keys.

    - get_json returns None for a missing key (telnyx.NotFoundError).
    - Any other failure is raised as KvError so callers can degrade cleanly.
    """

    def __init__(self, client: Any) -> None:
        self._client = client
        # Captured at construction so the namespace can be set per test/env.
        self._ns = require("KV_NAMESPACE_ID")

    async def get_json(self, key: str) -> Any:
        try:
            resp = await self._client.storage.kvs.keys.retrieve(key, id=self._ns)
            raw = await resp.read()
        except telnyx.NotFoundError:
            return None
        except (telnyx.APIError, httpx.HTTPError) as e:
            raise KvError(f"kv get {key!r}: {e}") from e
        if not raw:
            return None
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, ValueError) as e:
            raise KvError(f"kv get {key!r}: invalid json") from e

    async def put_json(self, key: str, value: Any, ttl_secs: int | None = None) -> None:
        body = json.dumps(value).encode()
        kwargs: dict[str, Any] = {"id": self._ns}
        if ttl_secs is not None:
            kwargs["ttl_secs"] = ttl_secs
        try:
            await self._client.storage.kvs.keys.update(key, body, **kwargs)
        except (telnyx.APIError, httpx.HTTPError) as e:
            raise KvError(f"kv put {key!r}: {e}") from e


# ------------------------------------------------------------- actor client

class ActorError(Exception):
    """Any failure calling the session-actor facade."""


class ActorInputError(ActorError):
    """A 4xx rejection — caller passed bad arguments to the actor."""


class ActorClient:
    """HTTP client for the TypeScript session-actor facade.

    POSTs JSON to {ACTOR_SERVICE_URL}/actors/{entity_id}/{method} with a
    Bearer INTERNAL_API_TOKEN and the current x-trace-id. Returns the JSON
    body. 4xx → ActorInputError, 5xx/network → ActorError.
    """

    def __init__(self, http: httpx.AsyncClient) -> None:
        self._http = http
        self._base = require("ACTOR_SERVICE_URL").rstrip("/")
        self._token = require("INTERNAL_API_TOKEN")
        # Name of the outbound trace header (configurable; default x-trace-id).
        self._trace_header = optional("TRACE_HEADER", "x-trace-id")

    async def call(self, entity_id: str, method: str, body: Any = None) -> Any:
        url = f"{self._base}/actors/{entity_id}/{method}"
        headers = {
            "authorization": f"Bearer {self._token}",
            self._trace_header: _trace_id,
            "content-type": "application/json",
        }
        try:
            resp = await self._http.post(url, json=body, headers=headers)
        except httpx.HTTPError as e:
            raise ActorError(f"actor {entity_id}/{method}: {e}") from e
        if resp.status_code >= 500:
            raise ActorError(f"actor {entity_id}/{method} returned {resp.status_code}")
        if resp.status_code >= 400:
            try:
                msg = resp.json().get("error") or resp.text
            except ValueError:
                msg = resp.text
            raise ActorInputError(f"actor {entity_id}/{method}: {msg}")
        return resp.json()


# ------------------------------------------------------------------ sessions

def _session_ttl() -> int:
    return integer("SESSION_TTL", 3600)


async def save_session(kv: Kv, conversation_id: str, phone: str) -> None:
    """Write the caller's phone for a conversation id (TTL = one call window)."""
    await kv.put_json(f"session/{conversation_id}", phone, ttl_secs=_session_ttl())


async def load_session(kv: Kv, conversation_id: str) -> str | None:
    """Return the phone saved for this conversation, or None if blank/missing."""
    if not conversation_id:
        return None
    return await kv.get_json(f"session/{conversation_id}")


# ------------------------------------------------------------------- phone

def entity_id(phone: str) -> str:
    """Strip a phone to digits only — the actor idFromName input. '' if empty."""
    return re.sub(r"\D", "", phone or "")


def mask(phone: str) -> str:
    """Mask a phone for logs: last 4 chars after '***'. '' if empty."""
    if not phone:
        return ""
    return "***" + phone[-4:]
