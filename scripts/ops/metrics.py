"""scripts/ops/metrics.py — read the live service metrics (the MetricsCounter actor).

The webhook and the MCP server add counters and latency samples to one shared
Stateful Actor; this logs its snapshot as one structured JSON line
(`metrics.snapshot`) with derived rates (degraded calls, cache hit rate).

    python scripts/ops/metrics.py           # show
    python scripts/ops/metrics.py --reset   # clear (e.g. before a demo)

Needs ACTOR_SERVICE_URL and INTERNAL_API_TOKEN in the environment (.env).
"""

from __future__ import annotations

import os
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))  # scripts/ops/ -> repo root
import common as c


def main() -> int:
    url = os.environ["ACTOR_SERVICE_URL"].rstrip("/")
    headers = {"Authorization": f"Bearer {os.environ['INTERNAL_API_TOKEN']}"}
    op = "reset" if "--reset" in sys.argv else "snapshot"
    try:
        resp = httpx.post(f"{url}/metrics/{op}", headers=headers, json={}, timeout=30)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        c.error("metrics.request_failed", op=op, error=str(e), exc_info=True)
        return 1
    if op == "reset":
        c.info("metrics.reset")
        return 0

    snap = resp.json()
    counts = snap.get("counts", {})
    since = snap.get("since")
    if since:  # stored in UTC; reported in LOG_TIMEZONE (Israel time)
        since = datetime.fromisoformat(since.replace("Z", "+00:00")).astimezone(
            ZoneInfo(os.environ.get("LOG_TIMEZONE", "Asia/Jerusalem"))).isoformat(timespec="seconds")
    calls, hits, misses = counts.get("webhook.calls", 0), counts.get("cache.hit", 0), counts.get("cache.miss", 0)
    c.info(
        "metrics.snapshot",
        since=since,
        counts=dict(sorted(counts.items())),
        degraded_rate=round(counts.get("webhook.degraded", 0) / calls, 3) if calls else None,
        cache_hit_rate=round(hits / (hits + misses), 3) if hits + misses else None,
        latency_ms=dict(sorted(snap.get("latency", {}).items())),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
