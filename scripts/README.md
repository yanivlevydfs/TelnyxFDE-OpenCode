# Scripts

Run from the repo root with the project virtualenv; the `ops/` scripts read the
values in `.env` (see [.env.example](../.env.example)). Every script logs through
the shared JSON logger (`info` / `debug` / `warning` / `error`, Israel-time `ts`).

## build/ — before testing or shipping

| Script | What it does |
| --- | --- |
| [vendor_shared.py](build/vendor_shared.py) | Copies `shared/common.py` into each Python service as `function/common.py` (Edge builds each service folder alone). The ship workflow runs it too. |

```bash
python scripts/build/vendor_shared.py
```

## ops/ — against the live Telnyx Edge deployment

| Script | What it does |
| --- | --- |
| [live_check.py](ops/live_check.py) | End-to-end PASS/FAIL check: security on all services, the 4 MCP tools, search by anywhere/weekend/country, save and list, hidden caller id, the SMS kill switch, concurrent actor updates, metrics. |
| [metrics.py](ops/metrics.py) | Live metrics dashboard from the `MetricsCounter` actor: counters, degraded-call rate, cache hit rate, latency. `--reset` clears it before a demo. |
| [actor_concurrency_check.py](ops/actor_concurrency_check.py) | Proof for the Stateful Actor: N concurrent `recordCall` requests, no lost updates. |
| [workflow_paths.py](ops/workflow_paths.py) | Walks every Conversation Workflow path over the Telnyx chat API on one throwaway assistant copy (greeting, FAQ, search, negatives, human, goodbye, degraded and deals-off fallbacks), then deletes the copy and its TeXML app. The timeout escalation needs a real call. |

```bash
python scripts/ops/live_check.py
python scripts/ops/metrics.py [--reset]
python scripts/ops/actor_concurrency_check.py 20
python scripts/ops/workflow_paths.py
```

`workflow_paths.py` sweeps the account first: it lists all assistants and deletes
any whose name ends with ` (path test)` plus the TeXML app Telnyx created for
it, logging each as `path.leftover_removed` (WARNING). It only ever touches
those copies, never the real assistant. The `finally` cleanup repeats that
delete for the copy it just made, with each call (retrieve the TeXML id, delete
the assistant, delete the TeXML app) in its own try/except — so a single failing
call logs an ERROR with a traceback and the remaining deletes still run, instead
of one failure leaving a copy behind on the account.
