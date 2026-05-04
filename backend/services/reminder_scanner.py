"""
Daily reminder scanner.

Two strategies:
1. **Warranty reminders** (stateless): scan documents whose warranty_end falls
   exactly N days from today, where N ∈ {30, 14, 7, 1, 0}. Sends one email per
   match. Since cron runs daily, each threshold fires exactly once per doc.
2. **Manual reminders** (stateful): scan public.reminders rows with
   remind_at <= now() AND status='pending'. Sends email and marks sent.

Both use the service-role Supabase client (bypasses RLS) and look up user
emails via the Supabase auth admin API.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

from supabase import Client, create_client

from ..config import settings
from .email import (
    EmailError,
    render_generic_reminder_email,
    render_warranty_email,
    send_email,
)

logger = logging.getLogger(__name__)

WARRANTY_THRESHOLDS = [30, 14, 7, 1, 0]  # days_left to alert


def _admin_client() -> Client:
    if not settings.SUPABASE_URL or not settings.SUPABASE_KEY:
        raise RuntimeError("SUPABASE_URL / SUPABASE_KEY missing")
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_KEY)


def _email_for_user(client: Client, user_id: str) -> str | None:
    """Look up the auth.users.email for a given user_id."""
    try:
        res = client.auth.admin.get_user_by_id(user_id)
        u = getattr(res, "user", None) or res
        email = getattr(u, "email", None)
        if not email and isinstance(u, dict):
            email = u.get("email")
        return email
    except Exception as e:
        logger.warning("Failed to resolve email for user %s: %s", user_id, e)
        return None


def _parse_date(s: str) -> date | None:
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except Exception:
        return None


# ============================================================
# Warranty scan
# ============================================================
def scan_warranty(client: Client) -> dict[str, int]:
    today = date.today()
    upper = today + timedelta(days=max(WARRANTY_THRESHOLDS) + 1)

    res = (
        client.table("documents")
        .select("id,user_id,name,warranty_end")
        .gte("warranty_end", today.isoformat())
        .lte("warranty_end", upper.isoformat())
        .execute()
    )
    docs = res.data or []
    sent = 0
    failed = 0
    skipped = 0
    email_cache: dict[str, str | None] = {}

    for doc in docs:
        end = _parse_date(doc.get("warranty_end") or "")
        if not end:
            skipped += 1
            continue
        days_left = (end - today).days
        if days_left not in WARRANTY_THRESHOLDS:
            skipped += 1
            continue

        uid = str(doc["user_id"])
        if uid not in email_cache:
            email_cache[uid] = _email_for_user(client, uid)
        email = email_cache[uid]
        if not email:
            skipped += 1
            continue

        subject, html, text = render_warranty_email(
            doc_name=doc.get("name") or "מסמך",
            warranty_end=end.isoformat(),
            days_left=days_left,
        )
        try:
            send_email(email, subject, html, text)
            sent += 1
        except EmailError as e:
            logger.error("Warranty email failed doc=%s: %s", doc.get("id"), e)
            failed += 1

    return {"scanned": len(docs), "sent": sent, "failed": failed, "skipped": skipped}


# ============================================================
# Manual reminders scan
# ============================================================
def scan_manual(client: Client) -> dict[str, int]:
    now_iso = datetime.now(timezone.utc).isoformat()
    res = (
        client.table("reminders")
        .select("id,user_id,name,type,remind_at,channel,status")
        .eq("status", "pending")
        .lte("remind_at", now_iso)
        .limit(500)
        .execute()
    )
    rems = res.data or []
    sent = 0
    failed = 0
    skipped = 0
    email_cache: dict[str, str | None] = {}

    for r in rems:
        if r.get("channel") not in (None, "email"):
            skipped += 1
            continue

        uid = str(r["user_id"])
        if uid not in email_cache:
            email_cache[uid] = _email_for_user(client, uid)
        email = email_cache[uid]
        if not email:
            skipped += 1
            continue

        # Format remind_at to a Hebrew-ish date string
        try:
            ra = datetime.fromisoformat((r.get("remind_at") or "").replace("Z", "+00:00"))
            ra_str = ra.strftime("%Y-%m-%d %H:%M")
        except Exception:
            ra_str = r.get("remind_at") or ""

        subject, html, text = render_generic_reminder_email(
            name=r.get("name") or "תזכורת",
            reminder_type=r.get("type") or "other",
            remind_at=ra_str,
        )
        try:
            send_email(email, subject, html, text)
            client.table("reminders").update(
                {"status": "sent", "sent_at": datetime.now(timezone.utc).isoformat()}
            ).eq("id", r["id"]).execute()
            sent += 1
        except EmailError as e:
            logger.error("Manual reminder email failed id=%s: %s", r.get("id"), e)
            try:
                client.table("reminders").update({"status": "failed"}).eq(
                    "id", r["id"]
                ).execute()
            except Exception:
                pass
            failed += 1

    return {"scanned": len(rems), "sent": sent, "failed": failed, "skipped": skipped}


# ============================================================
# Public entrypoint
# ============================================================
def run_scan() -> dict[str, Any]:
    client = _admin_client()
    warranty_stats = scan_warranty(client)
    manual_stats = scan_manual(client)
    summary = {
        "warranty": warranty_stats,
        "manual": manual_stats,
        "total_sent": warranty_stats["sent"] + manual_stats["sent"],
    }
    logger.info("Reminder scan complete: %s", summary)
    return summary
