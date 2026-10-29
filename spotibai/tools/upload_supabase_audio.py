#!/usr/bin/env python3
"""Upload bundled demo media to SpotiBai's Supabase Storage buckets.

Run: python3 spotibai/tools/upload_supabase_audio.py
Uses the public URL/anon key in js/config.js. The database permits INSERT-only
uploads for the bundled asset allowlist, so this cannot overwrite existing files.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CONFIG = (ROOT / "js" / "config.js").read_text(encoding="utf-8")


def config_value(name: str) -> str:
    match = re.search(rf"\b{name}:\s*'([^']*)'", CONFIG)
    if not match:
        raise SystemExit(f"Missing {name} in js/config.js")
    return match.group(1)


project_url = config_value("SUPABASE_URL").rstrip("/")
api_key = config_value("SUPABASE_ANON_KEY")
assets = [
    ("audio", file, "audio/mpeg")
    for file in sorted((ROOT / "assets" / "audio").glob("*.mp3"))
]
assets += [
    ("covers", file, "image/svg+xml")
    for file in sorted((ROOT / "assets" / "covers").glob("*.svg"))
]
if not assets:
    raise SystemExit("No bundled audio or cover assets were found")

uploaded = skipped = 0
for bucket, file_path, content_type in assets:
    endpoint = f"{project_url}/storage/v1/object/{bucket}/{file_path.name}"
    request = Request(
        endpoint,
        data=file_path.read_bytes(),
        method="POST",
        headers={
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )
    try:
        with urlopen(request, timeout=90):
            print(f"Uploaded {bucket}/{file_path.name} ({file_path.stat().st_size:,} bytes)")
            uploaded += 1
    except HTTPError as error:
        if error.code == 409:
            print(f"Already exists; skipped {bucket}/{file_path.name}")
            skipped += 1
            continue
        detail = error.read().decode("utf-8", errors="replace")
        print(f"Upload failed for {bucket}/{file_path.name}: HTTP {error.code}: {detail}", file=sys.stderr)
        raise SystemExit(1)
    except URLError as error:
        raise SystemExit(f"Could not reach Supabase while uploading {bucket}/{file_path.name}: {error}") from error

print(f"Done: {uploaded} uploaded, {skipped} already present.")
