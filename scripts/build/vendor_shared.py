"""scripts/build/vendor_shared.py — copy shared/common.py into each Python service.

    The Telnyx Edge build ships one function folder at a time, so shared Python
    code can't live in a package imported across services. Instead we keep ONE
    source of truth (shared/common.py) and vendor it into every Python service as
    function/common.py. Re-run after editing shared/common.py and before
    `telnyx-edge ship` or `python -m pytest tests`.

    python scripts/build/vendor_shared.py

    TypeScript services (services/session-actor, services/mcp-server) have no
    `function/` directory and are skipped automatically.
"""

from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]  # scripts/build/ -> repo root
SOURCE = ROOT / "shared" / "common.py"
sys.path.insert(0, str(SOURCE.parent))
import common as c  # noqa: E402  (shared JSON logger)


def main() -> int:
    if not SOURCE.is_file():
        c.error("vendor.source_missing", source=str(SOURCE))
        return 1

    # Every Python service lives in services/<name>/function/ ; TypeScript
    # services (e.g. session-actor) use src/ and won't match this glob.
    targets = sorted(p for p in (ROOT / "services").glob("*/function") if p.is_dir())
    if not targets:
        c.warning("vendor.no_services", path="services/*/function")
        return 0

    for fn_dir in targets:
        dest = fn_dir / "common.py"
        shutil.copy2(SOURCE, dest)
        c.info("vendor.copied", source=str(SOURCE.relative_to(ROOT)), dest=str(dest.relative_to(ROOT)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
