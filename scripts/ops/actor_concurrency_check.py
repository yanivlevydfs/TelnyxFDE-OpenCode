"""scripts/ops/actor_concurrency_check.py — prove the actor's read-modify-write is safe.

Fires N concurrent ``recordCall`` requests at ONE fresh CallerSession actor and
checks that every count 1..N came back exactly once and the final count is N.
A plain KV counter (last-write-wins, no compare-and-set) would lose updates
here; the Stateful Actor runs one method turn at a time per instance, so it
cannot. Used in the demo for requirement 4c.

    python scripts/ops/actor_concurrency_check.py [N]

Needs ACTOR_SERVICE_URL and INTERNAL_API_TOKEN in the environment (.env).
"""

from __future__ import annotations

import asyncio
import os
import random
import sys

import httpx


async def main(n: int) -> int:
    url = os.environ["ACTOR_SERVICE_URL"].rstrip("/")
    headers = {"Authorization": f"Bearer {os.environ['INTERNAL_API_TOKEN']}"}
    entity = f"1999{random.randint(10**6, 10**7)}"  # fresh test caller, digits only
    async with httpx.AsyncClient(timeout=60) as client:
        replies = await asyncio.gather(*[
            client.post(f"{url}/actors/{entity}/recordCall", headers=headers, json={})
            for _ in range(n)
        ])
        counts = sorted(r.json()["callCount"] for r in replies)
        final = (await client.post(f"{url}/actors/{entity}/getProfile",
                                   headers=headers, json={})).json()["callCount"]
    ok = counts == list(range(1, n + 1)) and final == n
    print(f"{n} concurrent recordCall -> counts {counts}")
    print(f"final callCount {final}: {'no lost updates' if ok else 'LOST UPDATES'}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 20)))
