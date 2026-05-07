"""
Account self-service endpoints.

Currently exposes a destructive `DELETE /api/account/delete` which wipes:
  - All of the user's storage objects under the `documents` bucket
  - All of their rows in the `documents` and `reminders` tables
  - Their Supabase auth user (so they can sign up again with the same email)

Authorization: standard user JWT via the shared `AuthDep`. The deletion of the
auth user itself requires the service-role key, so we use the singleton
service-role client from `database.get_supabase()` for that step only.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException

from ..auth import AuthContext, AuthDep
from ..database import get_supabase
from ..services.storage import BUCKET

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/account", tags=["account"])


def _list_all_user_objects(client, user_id: str) -> list[str]:
    """Recursively list every object under `<user_id>/` in the storage bucket.

    Supabase's storage `list()` returns one level at a time. We do a simple
    BFS so we collect files inside `<user_id>/<doc_id>/<file>`.
    """
    paths: list[str] = []
    queue: list[str] = [str(user_id)]
    seen: set[str] = set()
    while queue:
        prefix = queue.pop(0)
        if prefix in seen:
            continue
        seen.add(prefix)
        try:
            entries = client.storage.from_(BUCKET).list(prefix) or []
        except Exception as e:  # noqa: BLE001
            logger.warning("storage.list(%s) failed: %s", prefix, e)
            continue
        for entry in entries:
            name = entry.get("name") if isinstance(entry, dict) else None
            if not name:
                continue
            full = f"{prefix}/{name}"
            # Folders have a null `id` in Supabase storage list output.
            is_folder = isinstance(entry, dict) and entry.get("id") is None
            if is_folder:
                queue.append(full)
            else:
                paths.append(full)
    return paths


@router.delete("/delete")
def delete_account(ctx: AuthContext = AuthDep) -> dict:
    """Fully delete the calling user's data + auth record.

    This is irreversible. After it succeeds the user can sign up again with
    the same email as if they'd never registered.
    """
    user_id = str(ctx.user_id)
    admin = get_supabase()  # service-role client

    # 1) Remove storage objects (best-effort — keep going on errors).
    try:
        paths = _list_all_user_objects(admin, user_id)
        if paths:
            # Supabase remove() accepts up to ~1000 paths per call; chunk to be safe.
            for i in range(0, len(paths), 500):
                try:
                    admin.storage.from_(BUCKET).remove(paths[i:i + 500])
                except Exception as e:  # noqa: BLE001
                    logger.warning("storage remove batch failed: %s", e)
    except Exception as e:  # noqa: BLE001
        logger.warning("storage cleanup failed for %s: %s", user_id, e)

    # 2) Delete DB rows. RLS on `user_id` ensures we only touch the caller's
    # data even though we use the service-role client.
    for table in ("documents", "reminders"):
        try:
            admin.table(table).delete().eq("user_id", user_id).execute()
        except Exception as e:  # noqa: BLE001
            logger.warning("delete from %s failed for %s: %s", table, user_id, e)

    # 3) Delete the auth user — requires service role.
    try:
        admin.auth.admin.delete_user(user_id)
    except Exception as e:  # noqa: BLE001
        logger.exception("auth.admin.delete_user failed for %s", user_id)
        raise HTTPException(500, f"Failed to delete auth user: {e}")

    return {"ok": True}
