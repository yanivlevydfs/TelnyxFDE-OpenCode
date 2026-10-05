"""Shared test setup for every unit test in this folder.

Both Python services ship their code as a package named `function`, so each is
loaded here under its own name (webhook_fn, mcp_fn) to test them side by side.

Run all Python tests from the repo root:
    python scripts/vendor_shared.py
    .venv/Scripts/python -m pytest UnitTest -q
"""

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Test configuration only — real values come from Telnyx Edge secrets.
os.environ.update({
    "WEBHOOK_BUDGET_MS": "300",
    "FLYTLV_API_KEY": "flytlv-test",
    "MCP_API_KEY": "mcp-test",
    "DEALS_RESULT_LIMIT": "2",
})

sys.path.insert(0, str(ROOT / "shared"))  # `import common` = shared/common.py


def load_service(folder: str, alias: str):
    """Import services/<folder>/function as package `alias`; return its func module."""
    if f"{alias}.func" in sys.modules:
        return sys.modules[f"{alias}.func"]
    init = ROOT / "services" / folder / "function" / "__init__.py"
    if not (init.parent / "common.py").exists():
        raise RuntimeError("run `python scripts/vendor_shared.py` first")
    spec = importlib.util.spec_from_file_location(alias, init, submodule_search_locations=[str(init.parent)])
    package = importlib.util.module_from_spec(spec)
    sys.modules[alias] = package
    spec.loader.exec_module(package)
    return importlib.import_module(f"{alias}.func")
