"""
User preferences endpoint.

Generic per-user key/value store backed by `public.user_preferences`.
Frontend uses this to persist `categories`, `custom_tabs`, `sub_branches`
and similar UI state across devices. Each key holds an arbitrary JSON
value (object or array) — schema is owned by the client.

Endpoints
---------
GET    /api/preferences            → { key: value, ... } for all keys
GET    /api/preferences/{key}      → { key, value, updated_at }
PUT    /api/preferences/{key}      → upsert; body: { value: <any json> }
DELETE /api/preferences/{key}      → 204
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..auth import AuthContext, AuthDep

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/preferences", tags=["preferences"])

# Allow-list of keys clients may write. Keeping this server-side prevents
# the table being used as a free-form blob store and makes future schema
# work (e.g. dedicated columns) painless.
ALLOWED_KEYS = {
    "categories",        # user's full category list (array of objects)
    "custom_tabs",       # ordered list of custom subnav tabs
    "sub_branches",      # per-category sub-branch lists
    "tab_order",         # explicit tab display order
    "user_settings",     # misc UI settings (AI banner timeout, theme, etc.)
    "alerts_handled",    # bell-panel handled ids
    "alerts_pending",    # bell-panel "later" ids
    "avatar_color",      # avatar color picker selection
    "people",            # simple family-member chip list (legacy)
    "family_profiles",   # rich family/business profiles (with avatars, roles)
    "doc_color_map",     # per-doc color tag overrides
}


class PreferenceBody(BaseModel):
    value: Any


def _ensure_allowed(key: str) -> None:
    if key not in ALLOWED_KEYS:
        raise HTTPException(400, f"Unknown preference key: {key}")


@router.get("")
def list_preferences(ctx: AuthContext = AuthDep) -> dict[str, Any]:
    """Return all preferences for the caller as a flat dict."""
    try:
        res = (
            ctx.client.table("user_preferences")
            .select("key,value")
            .eq("user_id", str(ctx.user_id))
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("list_preferences failed: %s", e)
        raise HTTPException(500, "Failed to load preferences")
    out: dict[str, Any] = {}
    for row in (res.data or []):
        out[row["key"]] = row["value"]
    return out


@router.get("/{key}")
def get_preference(key: str, ctx: AuthContext = AuthDep) -> dict[str, Any]:
    _ensure_allowed(key)
    res = (
        ctx.client.table("user_preferences")
        .select("key,value,updated_at")
        .eq("user_id", str(ctx.user_id))
        .eq("key", key)
        .limit(1)
        .execute()
    )
    rows = res.data or []
    if not rows:
        return {"key": key, "value": None, "updated_at": None}
    return rows[0]


@router.put("/{key}")
def put_preference(
    key: str,
    body: PreferenceBody,
    ctx: AuthContext = AuthDep,
) -> dict[str, Any]:
    _ensure_allowed(key)
    payload = {
        "user_id": str(ctx.user_id),
        "key": key,
        "value": body.value,
    }
    try:
        # Upsert on (user_id, key). Note: supabase-py expects the conflict
        # target as a comma-separated string.
        ctx.client.table("user_preferences").upsert(
            payload, on_conflict="user_id,key"
        ).execute()
    except Exception as e:  # noqa: BLE001
        logger.warning("put_preference(%s) failed: %s", key, e)
        raise HTTPException(500, "Failed to save preference")
    return {"ok": True, "key": key}


@router.delete("/{key}", status_code=204)
def delete_preference(key: str, ctx: AuthContext = AuthDep) -> None:
    _ensure_allowed(key)
    try:
        (
            ctx.client.table("user_preferences")
            .delete()
            .eq("user_id", str(ctx.user_id))
            .eq("key", key)
            .execute()
        )
    except Exception as e:  # noqa: BLE001
        logger.warning("delete_preference(%s) failed: %s", key, e)
        raise HTTPException(500, "Failed to delete preference")
