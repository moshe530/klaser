from uuid import UUID

from fastapi import APIRouter, HTTPException, Query

from ..auth import AuthContext, AuthDep
from ..models import ReminderCreate, ReminderOut, ReminderUpdate

router = APIRouter(prefix="/reminders", tags=["reminders"])

TABLE = "reminders"


@router.get("", response_model=list[ReminderOut])
def list_reminders(
    auth: AuthContext = AuthDep,
    status_filter: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=100, le=500),
    offset: int = Query(default=0, ge=0),
):
    q = (
        auth.client.table(TABLE)
        .select("*")
        .eq("user_id", str(auth.user_id))
        .order("remind_at", desc=False)
        .range(offset, offset + limit - 1)
    )
    if status_filter:
        q = q.eq("status", status_filter)
    res = q.execute()
    return res.data or []


@router.post("", response_model=ReminderOut, status_code=201)
def create_reminder(payload: ReminderCreate, auth: AuthContext = AuthDep):
    row = payload.model_dump(mode="json", exclude_none=True)
    row["user_id"] = str(auth.user_id)
    res = auth.client.table(TABLE).insert(row).execute()
    if not res.data:
        raise HTTPException(500, "Insert failed")
    return res.data[0]


@router.get("/{rid}", response_model=ReminderOut)
def get_reminder(rid: UUID, auth: AuthContext = AuthDep):
    res = (
        auth.client.table(TABLE)
        .select("*")
        .eq("id", str(rid))
        .eq("user_id", str(auth.user_id))
        .single()
        .execute()
    )
    if not res.data:
        raise HTTPException(404, "Reminder not found")
    return res.data


@router.patch("/{rid}", response_model=ReminderOut)
def update_reminder(rid: UUID, payload: ReminderUpdate, auth: AuthContext = AuthDep):
    patch = payload.model_dump(mode="json", exclude_none=True)
    if not patch:
        raise HTTPException(400, "No fields to update")
    res = (
        auth.client.table(TABLE)
        .update(patch)
        .eq("id", str(rid))
        .eq("user_id", str(auth.user_id))
        .execute()
    )
    if not res.data:
        raise HTTPException(404, "Reminder not found")
    return res.data[0]


@router.delete("/{rid}", status_code=204)
def delete_reminder(rid: UUID, auth: AuthContext = AuthDep):
    auth.client.table(TABLE).delete().eq("id", str(rid)).eq(
        "user_id", str(auth.user_id)
    ).execute()
    return None
