"""
Supabase Storage helpers.

Path convention: documents/{user_id}/{doc_id}/{random}.{ext}
The first folder is user_id so RLS can enforce ownership. The filename is
randomized so user-supplied names can't probe storage paths or collide.
"""
from __future__ import annotations

import os
import re
import uuid as _uuid
from uuid import UUID

from supabase import Client

BUCKET = "documents"

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")
# Allowed file extensions (lower-case, no dot). Anything else gets ".bin".
_ALLOWED_EXTS = {"pdf", "png", "jpg", "jpeg", "webp", "heic"}


def _safe_extension(filename: str) -> str:
    """Return a sanitized lower-case extension from the user-supplied filename
    (no dot). Falls back to "bin" for unknown extensions."""
    _, ext = os.path.splitext(filename or "")
    ext = ext.lstrip(".").lower()
    ext = _SAFE_NAME_RE.sub("", ext)
    return ext if ext in _ALLOWED_EXTS else "bin"


def safe_filename(name: str) -> str:
    """Legacy helper kept for back-compat. Prefer `object_path` which now
    generates a random filename and ignores user-supplied names."""
    name = (name or "").strip().replace(" ", "_")
    name = _SAFE_NAME_RE.sub("_", name)
    return name or "file"


def object_path(user_id: UUID, doc_id: UUID, filename: str) -> str:
    """Build a storage path with a RANDOM filename derived from a UUID4.
    The user-supplied filename is only used for its extension."""
    ext = _safe_extension(filename)
    rand = _uuid.uuid4().hex
    return f"{user_id}/{doc_id}/{rand}.{ext}"


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
