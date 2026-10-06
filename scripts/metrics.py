"""scripts/metrics.py — print the live service metrics (the MetricsCounter actor).

The webhook and the MCP server add counters and latency samples to one shared
Stateful Actor; this prints its snapshot as a small terminal dashboard.

    python scripts/metrics.py           # show
    python scripts/metrics.py --reset   # clear (e.g. before a demo)

Needs ACTOR_SERVICE_URL and INTERNAL_API_TOKEN in the environment (.env).
"""

from __future__ import annotations

import os
import sys

import httpx


def main() -> int:
    url = os.environ["ACTOR_SERVICE_URL"].rstrip("/")
    headers = {"Authorization": f"Bearer {os.environ['INTERNAL_API_TOKEN']}"}
    op = "reset" if "--reset" in sys.argv else "snapshot"
    resp = httpx.post(f"{url}/metrics/{op}", headers=headers, json={}, timeout=30)
    resp.raise_for_status()
    if op == "reset":
        print("metrics reset")
        return 0
    snap = resp.json()
    print(f"FlyTLV metrics since {snap.get('since') or '-'} (UTC)\n")
    print("Counters")
    for name, value in sorted(snap.get("counts", {}).items()):
        print(f"  {name:<32} {value:>8g}")
    calls = snap.get("counts", {}).get("webhook.calls", 0)
    degraded = snap.get("counts", {}).get("webhook.degraded", 0)
    hits = snap.get("counts", {}).get("cache.hit", 0)
    misses = snap.get("counts", {}).get("cache.miss", 0)
    print("\nRates")
    print(f"  {'degraded calls':<32} {degraded / calls:>8.1%}" if calls else "  degraded calls: no calls yet")
    print(f"  {'deals cache hit rate':<32} {hits / (hits + misses):>8.1%}" if hits + misses else "  cache: no searches yet")
    print("\nLatency (ms)             count      avg      max")
    for name, s in sorted(snap.get("latency", {}).items()):
        print(f"  {name:<22} {s['count']:>7} {s['avg_ms']:>8} {s['max_ms']:>8}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
