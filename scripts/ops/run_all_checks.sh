#!/usr/bin/env bash
# scripts/ops/run_all_checks.sh — one demo script that runs every test and
# ops self-check.
#
# Usage:
#   bash scripts/ops/run_all_checks.sh          # steps 1, 2, 3, 5, 6
#   bash scripts/ops/run_all_checks.sh --full   # also step 4 (workflow_paths, ~3 min)
#
# Each step prints an "===== N. title =====" header, the step's output, and a
# final "PASS/FAIL N. title" line. Steps 3, 5 and (with --full) 4 pipe the ops
# script's JSON log through "$PY -c" into one readable line per check
# ("PASS <name>" / "FAIL <name> - <detail>" and a "label: X / Y passed"
# summary). A step failing never stops the rest; the script exits 1 at the end
# if any step failed.
#
# Works on Git Bash (Windows) and Linux. PY = .venv/Scripts/python if it
# exists, else .venv/bin/python.

set -u

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PY="$ROOT/.venv/Scripts/python"
[ -x "$PY" ] || PY="$ROOT/.venv/bin/python"
cd "$ROOT" || exit 1

FULL=0
[ "${1:-}" = "--full" ] && FULL=1

FAILED=0

header() { echo "===== $1. $2 ====="; }

# Print the step verdict from the exit code in $3 and flag a failure globally.
verdict() {
  if [ "$3" -eq 0 ]; then
    echo "PASS $1. $2"
  else
    echo "FAIL $1. $2"
    FAILED=1
  fi
}

# Run an ops script and turn its JSON log into readable lines:
#   argv[1] = name field ("check" or "path"), argv[2] = summary label.
# filter_run <script> <name_field> <label>  → exits with the script's code.
filter_run() {
  "$PY" "$ROOT/$1" | "$PY" -c '
import json, sys
name_field, label = sys.argv[1], sys.argv[2]
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        o = json.loads(line)
    except Exception:
        print(line)
        continue
    ev = o.get("event", "")
    if ev.endswith(".pass"):
        print("PASS " + str(o.get(name_field, "")))
    elif ev.endswith(".fail"):
        name = str(o.get(name_field, ""))
        detail = o.get("detail", "")
        if not detail and "turns" in o:
            turns = o["turns"]
            detail = turns[-1].get("assistant", "") if turns else ""
        detail = " ".join(str(detail or "").split())[:120]
        print(("FAIL " + name + " - " + detail) if detail else ("FAIL " + name))
    elif ev.endswith(".summary"):
        print(str(label) + ": " + str(o.get("passed", 0)) + " / " + str(o.get("total", 0)) + " passed")
    elif o.get("level") == "ERROR":
        msg = o.get("detail") or o.get("msg") or o.get("error") or ""
        print(("ERROR " + ev + " - " + str(msg)) if msg else ("ERROR " + ev))
' "$2" "$3"
  return ${PIPESTATUS[0]}
}

# 1. Python acceptance tests
header 1 "pytest suite"
"$PY" -m pytest tests -q
rc=$?
verdict 1 "pytest suite" "$rc"

# 2. Session-actor (TypeScript)
header 2 "session-actor npm test"
( cd "$ROOT/services/session-actor" && npm test --silent )
rc=$?
verdict 2 "session-actor npm test" "$rc"

# 3. Live ops checks (webhook, MCP, actor, metrics)
header 3 "live ops checks"
filter_run "scripts/ops/live_check.py" check live_check
rc=$?
verdict 3 "live ops checks" "$rc"

# 4. Walk every workflow path (~3 min; --full only)
if [ "$FULL" -eq 1 ]; then
  header 4 "workflow paths"
  filter_run "scripts/ops/workflow_paths.py" path workflow_paths
  rc=$?
  verdict 4 "workflow paths" "$rc"
fi

# 5. Cloud Storage bucket (read-only)
header 5 "storage check"
filter_run "scripts/ops/storage_check.py" check storage_check
rc=$?
verdict 5 "storage check" "$rc"

# 6. Live metrics snapshot
header 6 "metrics snapshot"
"$PY" "$ROOT/scripts/ops/metrics.py"
rc=$?
verdict 6 "metrics snapshot" "$rc"

exit $FAILED
