"""FlyTLV Dynamic Variables webhook — Telnyx Edge Function (Python).

Contents of this package:

- ``func.py`` — the service itself (routes, dependency calls, Edge entry point).
- ``common.py`` — vendored copy of ``shared/common.py`` made by
  ``scripts/build/vendor_shared.py``. Do not edit it here; edit the shared source.
"""

from .func import new  # Edge entry point: the runtime runs `from function import new`

__all__ = ["new"]
