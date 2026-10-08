"""scripts/ops/history.py — read-only caller history + audit report (step 20).

Answers "what did this caller look for (destinations, dates, flights) and when?"
across three layers, all read-only:

1. **Telnyx conversations** for the caller (filtered on
   ``metadata_telnyx_end_user_target``), newest first, each with its
   **insight results** when present (``retrieve_conversations_insights`` — the
   four FlyTLV caller-intent insights: destinations, dates/trip type, deal
   saved, call outcome).
2. **The caller's in-actor search/save history** timeline (``getHistory`` on
   the session-actor HTTP facade) — the quick read; the actor serializes turns
   so this is a consistent snapshot.
3. Audit copies of every event live durable in Cloud Storage under ``audit/``
   (written by the actor's ``_writeAudit``); this script does not read the
   bucket — it surfaces the in-actor view. ``--date YYYY-MM-DD`` narrows the
   report to conversations created on that day (Israel time).

    python scripts/ops/history.py --caller +972...
    python scripts/ops/history.py --date 2026-10-08
    python scripts/ops/history.py --caller +972... --date 2026-10-08

Needs ``TELNYX_API_KEY`` (conversations + insights) and, when ``--caller`` is
given, ``ACTOR_SERVICE_URL`` + ``INTERNAL_API_TOKEN`` (actor ``getHistory``).
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import timezone
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
import telnyx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))  # scripts/ops/ -> repo root
import common as c


def _report_tz() -> ZoneInfo:
    """Report timezone from LOG_TIMEZONE (default Asia/Jerusalem); UTC if unknown."""
    try:
        return ZoneInfo(os.environ.get("LOG_TIMEZONE", "Asia/Jerusalem"))
    except (ZoneInfoNotFoundError, ValueError):
        return timezone.utc  # type: ignore[return-value]


def _conv_date_iso(conv: object, tz: ZoneInfo) -> str:
    """YYYY-MM-DD of a conversation's created_at in the report timezone."""
    dt = getattr(conv, "created_at", None)
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(tz).strftime("%Y-%m-%d")


def _iso(dt: object) -> str:
    """ISO 8601 string of a datetime, or ""."""
    if dt is None:
        return ""
    try:
        return dt.isoformat()
    except (AttributeError, ValueError):
        return str(dt)


def _meta(conv: object) -> dict[str, str]:
    """The conversation metadata dict (Telnyx stores end_user_target etc here)."""
    meta = getattr(conv, "metadata", None)
    return dict(meta) if isinstance(meta, dict) else {}


async def _insight_names(client: telnyx.AsyncTelnyx) -> dict[str, str]:
    """Map insight_id -> name (for readable output), best-effort. Empty on failure."""
    mapping: dict[str, str] = {}
    try:
        pager = client.ai.conversations.insights.list(page_size=100)  # def, not async
        async for ins in pager:  # type: ignore[union-attr]
            name = getattr(ins, "name", None)
            if name:
                mapping[getattr(ins, "id", "")] = name
    except telnyx.APIError as exc:
        c.warning("history.insight_names_failed", error=str(exc))
    return mapping


async def _conversation_insights(
    client: telnyx.AsyncTelnyx,
    conv_id: str,
    names: dict[str, str],
) -> list[dict[str, str]] | None:
    """Insight results for one conversation, when present (status completed),
    or None if insights have not run / cannot be read."""
    try:
        resp = await client.ai.conversations.retrieve_conversations_insights(conv_id)
    except telnyx.APIError as exc:
        c.warning("history.insight_read_failed", conversation=conv_id, error=str(exc))
        return None
    results: list[dict[str, str]] = []
    for item in getattr(resp, "data", None) or []:
        if getattr(item, "status", None) != "completed":
            continue
        for ci in getattr(item, "conversation_insights", None) or []:
            iid = getattr(ci, "insight_id", "")
            results.append({
                "insight_id": iid,
                "name": names.get(iid, ""),
                "result": getattr(ci, "result", ""),
            })
    return results or None


async def _run(caller: str | None, date: str | None) -> int:
    api_key = c.require("TELNYX_API_KEY")
    client = telnyx.AsyncTelnyx(api_key=api_key)
    tz = _report_tz()
    try:
        # 1. Telnyx conversations, filtered by caller when given.
        list_kwargs: dict[str, object] = {"order": "created_at.desc", "limit": 100}
        if caller:
            # PostgREST expression on the metadata field (E.164, with the +).
            list_kwargs["metadata_telnyx_end_user_target"] = f"eq.{caller}"
        try:
            resp = await client.ai.conversations.list(**list_kwargs)
        except telnyx.APIError as exc:
            c.error("history.list_failed", error=str(exc), exc_info=True)
            return 1
        conversations = list(getattr(resp, "data", None) or [])
        if date:
            conversations = [
                conv for conv in conversations if _conv_date_iso(conv, tz) == date
            ]

        names = await _insight_names(client)
        for conv in conversations:
            cid = getattr(conv, "id", "")
            meta = _meta(conv)
            insights = await _conversation_insights(client, cid, names)
            c.info(
                "history.conversation",
                conversation_id=cid,
                created_at=_iso(getattr(conv, "created_at", None)),
                last_message_at=_iso(getattr(conv, "last_message_at", None)),
                end_user_target=meta.get("telnyx_end_user_target", ""),
                channel=meta.get("telnyx_conversation_channel", ""),
                insights=insights,
            )

        # 2. The caller's in-actor history timeline (needs the caller's digits).
        actor_history: dict[str, object] | None = None
        if caller:
            digits = c.entity_id(caller)
            if digits:
                actor_history = _actor_history(digits)
            else:
                c.warning("history.actor_skipped", reason="caller has no digits")

        c.info(
            "history.summary",
            caller=c.mask(caller or ""),
            date=date or "",
            conversations=len(conversations),
            actor_history=bool(actor_history),
            actor_history_data=actor_history,
        )
        return 0
    finally:
        await client.close()


def _actor_history(digits: str) -> dict[str, object] | None:
    """Call the session-actor HTTP facade ``getHistory`` for the caller."""
    base = os.environ.get("ACTOR_SERVICE_URL", "").rstrip("/")
    token = os.environ.get("INTERNAL_API_TOKEN", "")
    if not base or not token:
        c.warning("history.actor_skipped", reason="ACTOR_SERVICE_URL or INTERNAL_API_TOKEN not set")
        return None
    try:
        r = httpx.post(
            f"{base}/actors/{digits}/getHistory",
            headers={"Authorization": f"Bearer {token}"}, json={}, timeout=30,
        )
    except httpx.HTTPError as exc:
        c.warning("history.actor_history_failed", caller=c.mask(digits), error=str(exc))
        return None
    if r.status_code != 200:
        c.warning("history.actor_history_failed", caller=c.mask(digits), status=r.status_code)
        return None
    try:
        return r.json()  # { history: HistoryEntry[] }
    except ValueError:
        c.warning("history.actor_history_failed", caller=c.mask(digits), reason="invalid json")
        return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="history",
        description="Read-only caller history + audit report (Telnyx conversations, insights, actor getHistory).",
    )
    parser.add_argument("--caller", help="Caller phone number, E.164 with + (e.g. +972...).")
    parser.add_argument("--date", help="Only conversations created on this YYYY-MM-DD (Israel time).")
    args = parser.parse_args(argv)
    if not args.caller and not args.date:
        parser.error("provide --caller and/or --date")
    return asyncio.run(_run(args.caller, args.date))


if __name__ == "__main__":
    raise SystemExit(main())
