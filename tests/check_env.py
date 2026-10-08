"""tests/check_env.py — owner rule 3 ("nothing hardcoded") guard (step 21).

Scans the repo's .py and .ts sources (NOT .venv, node_modules or reference/)
for environment-variable reads and fails — naming the variable — when one is
missing from .env.example. This keeps the repo honest: every setting lives in
the environment, and `.env.example` documents every one of them.

Prompt / speak-node text, tool names, storage key names and regexes are
code/content (not settings), so they live in code and are never flagged.

Run:  .venv/Scripts/python -m pytest tests/check_env.py -q
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent
ENV_EXAMPLE = REPO / ".env.example"

# Directories never to scan (vendored / generated / external).
SKIP_DIR_PARTS = {".venv", "node_modules", "reference", ".git"}
# This file scans itself too; skip its own patterns so its regex string literals
# can never flag themselves as missing env vars.
SELF_FILE = "check_env.py"

# A valid env var name as used by .env.example: SCREAMING_SNAKE_CASE. We only
# capture all-uppercase identifiers from env-read call sites, so this is also the
# shape of every name we report.
ENV_NAME = re.compile(r"^[A-Z][A-Z0-9_]*$")
# Test sentinel convention (tests/test_common.py monkeypatches `X_REQ`, `X_INT`,
# `X_FLAG`, `X_MISSING` to exercise the helpers — those are NOT real env reads).
# No production env var in the repo starts with `X_`, so this is safe.
TEST_SENTINEL = re.compile(r"^X_")

# ---------------------------------------------------------------- read scanners
#
# Each pattern captures group 1 = the env var name. We restrict captures to
# all-uppercase identifiers so generic calls to `require(...)`, `flag(...)`,
# `get(...)` etc. with non-env arguments (e.g. `flag("verbose")`) cannot trip
# the guard. Bindings read as `env.NAME` (Telnyx Cloud Storage / KV / actor
# stubs) are deliberately NOT scanned: those are declared in func.toml /
# telnyx.toml, not .env.example.

# Python: direct os.environ access and the shared/common.py config helpers
# (`require` / `optional` / `integer` / `flag`), plus assistant/provision.py's
# `_req`/`_opt`/`_int` and its `env.get(...)` / `env.setdefault(...)` on the
# `os.environ` dict, and scripts/ops' `E["NAME"]` / `E.get("NAME")`.
PY_PATTERNS = [
    re.compile(r"\bos\.environ\.get\(\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\bos\.environ\[\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\bos\.getenv\(\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\b(?:require|optional|integer|flag)\(\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\benv\.get\(\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\benv\.setdefault\(\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\b_(?:req|opt|int)\(\s*\w+\s*,\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\bE\.get\(\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
    re.compile(r"\bE\[\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]\s*\]"),
]

# TypeScript: `process.env.NAME`, bracket access, and the mcp-server config
# helpers (`config.require/optional/integer/flag`). `env.NAME` bindings are NOT
# scanned (they come from func.toml / telnyx.toml, not .env.example).
TS_PATTERNS = [
    re.compile(r"\bprocess\.env\.([A-Z][A-Z0-9_]{1,})\b"),
    re.compile(r"\bprocess\.env\[\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]\s*\]"),
    re.compile(r"\bconfig\.(?:require|optional|integer|flag)\(\s*['\"]([A-Z][A-Z0-9_]{1,})['\"]"),
]


def _iter_source_files() -> list[tuple[Path, list[re.Pattern]]]:
    """Yield (path, patterns) for every .py / .ts / .mts / .tsx to scan."""
    out: list[tuple[Path, list[re.Pattern]]] = []
    for path in REPO.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIR_PARTS for part in path.parts):
            continue
        name = path.name
        if name == SELF_FILE:
            continue
        if name.endswith(".py"):
            out.append((path, PY_PATTERNS))
        elif name.endswith((".ts", ".mts", ".tsx")):
            out.append((path, TS_PATTERNS))
    return out


def _read_env_example() -> set[str]:
    """Return the set of env var names declared in .env.example."""
    names: set[str] = set()
    for raw in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name = line.split("=", 1)[0].strip()
        if ENV_NAME.match(name):
            names.add(name)
    return names


def _env_reads() -> dict[str, list[str]]:
    """Map each read env var name -> list of `file:line` sites that read it."""
    reads: dict[str, list[str]] = {}
    for path, patterns in _iter_source_files():
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for n, line in enumerate(text.splitlines(), start=1):
            for pat in patterns:
                for m in pat.finditer(line):
                    name = m.group(1)
                    if ENV_NAME.match(name) and not TEST_SENTINEL.match(name):
                        reads.setdefault(name, []).append(f"{path.relative_to(REPO)}:{n}")
    return reads


def test_env_example_covers_every_env_var_read() -> None:
    """Every env var read in the repo must be declared in .env.example.

    Prompt / speak-node text, tool names, storage key names and regexes are
    code/content, not settings, so they stay in code and are never reported.
    """
    declared = _read_env_example()
    reads = _env_reads()
    assert reads, "no env var reads found — the scanner is broken"  # sanity
    missing = sorted(set(reads) - declared)
    if missing:
        details = "\n".join(
            f"  {name}  read at " + ", ".join(reads[name][:3]) for name in missing
        )
        pytest.fail(
            f"{len(missing)} env var(s) read but missing from .env.example:\n{details}\n"
            f"Add each one to .env.example (grouped by component, with the code's "
            f"default and a one-line comment), or move it back into code if it is "
            f"prompt / speak text, a tool name, a storage key or a regex."
        )


def test_env_example_only_declares_known_shape() -> None:
    """Sanity: every .env.example entry is an UPPER_SNAKE env var name."""
    declared = _read_env_example()
    assert declared, ".env.example is empty or unparsable"
    for name in declared:
        assert ENV_NAME.match(name), f"bad env var name in .env.example: {name!r}"
