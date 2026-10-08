"""scripts/ops/storage_check.py — read-only check of the Cloud Storage bucket.

The `flytlv-itineraries` bucket has a hard account limit of at most
`STORAGE_MAX_OBJECTS` (default 5) objects (owner, 2026-10-08). Step 22 changed
the code to write a FIXED set of keys (itinerary slots + one audit key) and
overwrite them, never growing. This script lists the bucket over the S3 API
with sigv4 and fails when:

  - the bucket holds more than `STORAGE_MAX_OBJECTS` objects, or
  - any key is outside the allowed set (the fixed `itineraries/slot-<n>.html`
    keys + `audit/latest.json`).

Read-only: never writes or deletes anything.

    python scripts/ops/storage_check.py

    Needs the .env values: STORAGE_S3_ENDPOINT, STORAGE_S3_REGION, STORAGE_BUCKET
    and TELNYX_API_KEY. Verified live (2026-10-08): sigv4 signing with the Telnyx
    API key as BOTH the S3 access key and the secret key lists the bucket, so
    TELNYX_API_KEY is the default for both. Set the optional STORAGE_S3_ACCESS_KEY
    / STORAGE_S3_SECRET_KEY to override either one. Optionally ITINERARY_SLOTS
    (default 4), STORAGE_MAX_OBJECTS (default 5).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
import common as c

c.load_env()

E = os.environ


def _allowed_keys(slots: int) -> set[str]:
    """The complete set of keys the code is allowed to write (step 22).
    ITINERARY_SLOTS (default 4) slot keys + one audit key = at most 5."""
    keys = {f"itineraries/slot-{n}.html" for n in range(slots)}
    keys.add("audit/latest.json")
    return keys


# --------------------------------------------------------------- sigv4 signing

def _sigv4_sign(
    method: str,
    url: str,
    access_key: str,
    secret_key: str,
    region: str,
    service: str = "s3",
    payload_hash: str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",  # empty
) -> dict[str, str]:
    """Build AWS S3 sigv4 headers for a GET request. Only the headers
    needed for ListObjectsV2 are signed; the query string is empty (list
    params go in the URL query)."""
    now = datetime.now(timezone.utc)
    amz_date = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")

    parsed = httpx.URL(url)
    host = parsed.host
    path = parsed.path or "/"

    # Canonical headers (must be sorted)
    headers_to_sign = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    canonical_headers = "".join(
        f"{k}:{v.strip()}\n" for k, v in sorted(headers_to_sign.items())
    )
    signed_headers = ";".join(sorted(headers_to_sign.keys()))

    canonical_request = (
        f"{method}\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    )

    credential_scope = f"{date_stamp}/{region}/{service}/aws4_request"
    string_to_sign = (
        f"AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n"
        + hashlib.sha256(canonical_request.encode()).hexdigest()
    )

    def _hmac_sha(key: bytes, msg: str) -> bytes:
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    signing_key = _hmac_sha(
        _hmac_sha(
            _hmac_sha(
                _hmac_sha(("AWS4" + secret_key).encode(), date_stamp),
                region,
            ),
            service,
        ),
        "aws4_request",
    )
    signature = hmac.new(signing_key, string_to_sign.encode(), hashlib.sha256).hexdigest()

    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access_key}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    return {
        "authorization": authorization,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }


def _list_bucket_keys(
    endpoint: str,
    bucket: str,
    access_key: str,
    secret_key: str,
    region: str,
) -> list[str]:
    """List all object keys in the bucket via S3 ListObjectsV2 (sigv4-signed).

    Paginates until `isTruncated` is false. Returns a list of object keys.
    """
    url = f"{endpoint}/{quote(bucket)}?list-type=2"
    keys: list[str] = []
    continuation_token = ""
    while True:
        full_url = url
        if continuation_token:
            full_url += f"&continuation-token={quote(continuation_token)}"
        headers = _sigv4_sign("GET", full_url, access_key, secret_key, region)
        resp = httpx.get(full_url, headers=headers, timeout=30)
        if resp.status_code != 200:
            raise RuntimeError(
                f"S3 ListObjectsV2 returned {resp.status_code}: {resp.text[:200]}",
            )
        # Parse the XML response for <Key> and <IsTruncated> / <NextContinuationToken>.
        text = resp.text
        import re
        key_matches = re.findall(r"<Key>([^<]+)</Key>", text)
        keys.extend(key_matches)
        trunc_match = re.search(r"<IsTruncated>([^<]+)</IsTruncated>", text)
        is_truncated = trunc_match and trunc_match.group(1).lower() == "true"
        if not is_truncated:
            break
        next_match = re.search(r"<NextContinuationToken>([^<]+)</NextContinuationToken>", text)
        if not next_match:
            break
        continuation_token = next_match.group(1)
    return keys


def main() -> int:
    # Credentials: the Telnyx API key works as BOTH the S3 access key and the
    # secret key for sigv4 (verified live, 2026-10-08). STORAGE_S3_ACCESS_KEY /
    # STORAGE_S3_SECRET_KEY are optional overrides (e.g. a dedicated S3 key).
    telnyx_key = E.get("TELNYX_API_KEY", "")
    access_key = E.get("STORAGE_S3_ACCESS_KEY", "") or telnyx_key
    secret_key = E.get("STORAGE_S3_SECRET_KEY", "") or telnyx_key
    region = E.get("STORAGE_S3_REGION", "us-central-1")
    endpoint = E.get("STORAGE_S3_ENDPOINT") or f"https://{region}.telnyxcloudstorage.com"
    bucket = E.get("STORAGE_BUCKET", "flytlv-itineraries")
    slots = int(E.get("ITINERARY_SLOTS", "4"))
    max_objects = int(E.get("STORAGE_MAX_OBJECTS", "5"))

    if not access_key or not secret_key:
        c.error("storage_check.missing_credentials",
                    msg="Set TELNYX_API_KEY (or STORAGE_S3_ACCESS_KEY / STORAGE_S3_SECRET_KEY)")
        return 1

    try:
        keys = _list_bucket_keys(endpoint, bucket, access_key, secret_key, region)
    except (RuntimeError, httpx.HTTPError, OSError) as exc:
        c.error("storage_check.list_failed", error=str(exc), bucket=bucket, exc_info=True)
        return 1

    c.info("storage_check.keys", bucket=bucket, count=len(keys), keys=keys)

    allowed = _allowed_keys(slots)
    unexpected = [k for k in keys if k not in allowed]
    too_many = len(keys) > max_objects

    results: list[tuple[str, bool, str]] = [
        ("bucket has no more than STORAGE_MAX_OBJECTS keys",
         not too_many, f"{len(keys)} / {max_objects}"),
        ("all keys are inside the allowed set",
         not unexpected, ", ".join(unexpected) or "OK"),
    ]

    all_ok = True
    for name, ok, detail in results:
        (c.info if ok else c.error)(f"storage_check.{'pass' if ok else 'fail'}",
                                      check=name, detail=detail)
        if not ok:
            all_ok = False

    if all_ok:
        c.info("storage_check.summary", passed=len(results), total=len(results), failed=[])
        return 0
    failed_names = [n for n, ok, _ in results if not ok]
    c.error("storage_check.summary", passed=len(results) - len(failed_names),
              total=len(results), failed=failed_names)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
