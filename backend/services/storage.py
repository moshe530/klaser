"""
Supabase Storage helpers.

Path convention: documents/{user_id}/{doc_id}/{filename}
The first folder is user_id so RLS can enforce ownership.
"""
from __future__ import annotations

import re
from uuid import UUID

from supabase import Client

BUCKET = "documents"

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def safe_filename(name: str) -> str:
    """Replace unsafe chars (incl. spaces & non-ASCII) with underscores.
    Storage paths must be ASCII to avoid header-encoding issues."""
    name = name.strip().replace(" ", "_")
    name = _SAFE_NAME_RE.sub("_", name)
    return name or "file"


def object_path(user_id: UUID, doc_id: UUID, filename: str) -> str:
    return f"{user_id}/{doc_id}/{safe_filename(filename)}"


def upload_bytes(client: Client, path: str, data: bytes, content_type: str) -> None:
    client.storage.from_(BUCKET).upload(
        path=path,
        file=data,
        file_options={"content-type": content_type, "upsert": "true"},
    )


def download_bytes(client: Client, path: str) -> bytes:
    """Download file content as bytes."""
    res = client.storage.from_(BUCKET).download(path)
    if isinstance(res, (bytes, bytearray)):
        return bytes(res)
    # Some supabase-py versions return a response-like object
    return getattr(res, "content", res)


def remove(client: Client, path: str) -> None:
    try:
        client.storage.from_(BUCKET).remove([path])
    except Exception:
        # Idempotent — ignore if file already gone
        pass


def signed_url(client: Client, path: str, expires_in: int = 600) -> str:
    res = client.storage.from_(BUCKET).create_signed_url(path, expires_in)
    # supabase-py returns dict with 'signedURL' or 'signedUrl' depending on version
    return res.get("signedURL") or res.get("signedUrl") or res.get("signed_url") or ""
