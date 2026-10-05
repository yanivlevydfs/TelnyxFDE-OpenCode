"""scripts/vendor_shared.py — copy shared/common.py into each Python service.

The Telnyx Edge build ships one function folder at a time, so shared Python
code can't live in a package imported across services. Instead we keep ONE
source of truth (shared/common.py) and vendor it into every Python service as
function/common.py. Re-run after editing shared/common.py and before
`telnyx-edge ship` or `python -m pytest UnitTest`.

    python scripts/vendor_shared.py

TypeScript services (services/session-actor) have no `function/` directory and
are skipped automatically.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "shared" / "common.py"


def main() -> int:
    if not SOURCE.is_file():
        print(f"error: source not found: {SOURCE}", file=sys.stderr)
        return 1

    # Every Python service lives in services/<name>/function/ ; TypeScript
    # services (e.g. session-actor) use src/ and won't match this glob.
    targets = sorted(p for p in (ROOT / "services").glob("*/function") if p.is_dir())
    if not targets:
        print("no Python services found under services/*/ — nothing to vendor.")
        return 0

    for fn_dir in targets:
        dest = fn_dir / "common.py"
        shutil.copy2(SOURCE, dest)
        print(f"vendored {SOURCE.relative_to(ROOT)} -> {dest.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
