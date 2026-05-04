"""
Email sending service via Resend (https://resend.com).

Requires RESEND_API_KEY env var. Uses httpx (already a transitive dep
of supabase-py) for the HTTP call.

The FROM address can be customized with RESEND_FROM env var
(default: "Klaser <onboarding@resend.dev>" — Resend's sandbox sender,
which only delivers to verified addresses on the same Resend account).
For production: verify your own domain on Resend.
"""
from __future__ import annotations

import logging
from typing import Iterable

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"
DEFAULT_FROM = "Klaser <onboarding@resend.dev>"


class EmailError(Exception):
    pass


def send_email(
    to: str | Iterable[str],
    subject: str,
    html: str,
    text: str | None = None,
    from_addr: str | None = None,
) -> str:
    """Send a single email via Resend. Returns the Resend message id."""
    if not settings.RESEND_API_KEY:
        raise EmailError("RESEND_API_KEY missing")

    sender = from_addr or getattr(settings, "RESEND_FROM", "") or DEFAULT_FROM
    recipients = [to] if isinstance(to, str) else list(to)

    payload: dict = {
        "from": sender,
        "to": recipients,
        "subject": subject,
        "html": html,
    }
    if text:
        payload["text"] = text

    headers = {
        "Authorization": f"Bearer {settings.RESEND_API_KEY}",
        "Content-Type": "application/json",
    }

    try:
        with httpx.Client(timeout=15.0) as client:
            resp = client.post(RESEND_API_URL, json=payload, headers=headers)
    except httpx.HTTPError as e:
        logger.error("Resend HTTP error: %s", e)
        raise EmailError(f"HTTP error: {e}") from e

    if resp.status_code >= 300:
        logger.error("Resend rejected email: %s %s", resp.status_code, resp.text)
        raise EmailError(f"Resend {resp.status_code}: {resp.text}")

    data = resp.json()
    msg_id = data.get("id", "")
    logger.info("Email sent to=%s subject=%r id=%s", recipients, subject, msg_id)
    return msg_id


# ============================================================
# Templates (Hebrew, RTL HTML)
# ============================================================

_BASE_STYLE = """
<style>
  body{font-family:-apple-system,Segoe UI,Heebo,Arial,sans-serif;background:#F0EDE6;margin:0;padding:24px;color:#1A1814;}
  .card{max-width:560px;margin:0 auto;background:#FAFAF8;border-radius:14px;padding:28px;box-shadow:0 2px 8px rgba(0,0,0,0.06);}
  .logo{display:inline-block;background:#1A4A9E;color:#fff;font-weight:800;padding:8px 14px;border-radius:8px;font-size:18px;}
  h1{font-size:20px;margin:18px 0 10px;color:#0D2B5E;}
  p{font-size:15px;line-height:1.6;color:#1A1814;margin:8px 0;}
  .doc-name{font-weight:700;color:#0D2B5E;}
  .meta{background:#EFEDE7;border-radius:9px;padding:14px 16px;margin:14px 0;}
  .meta-row{display:flex;justify-content:space-between;padding:4px 0;font-size:14px;}
  .meta-row b{color:#0D2B5E;}
  .cta{display:inline-block;background:#1A4A9E;color:#fff !important;text-decoration:none;font-weight:600;padding:10px 22px;border-radius:9px;margin-top:14px;}
  .footer{font-size:12px;color:#6A6660;text-align:center;margin-top:20px;}
  .badge-urgent{background:#FEE2E2;color:#991B1B;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;}
  .badge-soon{background:#FEF3C7;color:#92400E;font-size:11px;font-weight:700;padding:2px 8px;border-radius:6px;}
</style>
"""


def render_warranty_email(
    doc_name: str,
    warranty_end: str,
    days_left: int,
    app_url: str = "https://gleaming-selkie-ccb973.netlify.app",
) -> tuple[str, str, str]:
    """Returns (subject, html, text) for a warranty-expiry reminder."""
    badge = '<span class="badge-urgent">דחוף</span>' if days_left <= 7 else '<span class="badge-soon">קרוב</span>'
    when = "היום" if days_left == 0 else (
        "מחר" if days_left == 1 else f"בעוד {days_left} ימים"
    )
    subject = f"🛡️ {doc_name} — תפוגת אחריות {when}"
    html = f"""
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8">{_BASE_STYLE}</head>
<body>
  <div class="card">
    <div class="logo">📁 קלסר</div>
    <h1>תזכורת לתפוגת אחריות {badge}</h1>
    <p>שלום,</p>
    <p>האחריות על <span class="doc-name">{doc_name}</span> פגה <b>{when}</b>.</p>
    <div class="meta">
      <div class="meta-row"><span>שם המסמך</span><b>{doc_name}</b></div>
      <div class="meta-row"><span>תאריך תפוגה</span><b>{warranty_end}</b></div>
      <div class="meta-row"><span>ימים נותרים</span><b>{days_left}</b></div>
    </div>
    <p>זה הזמן לבדוק אם כדאי להאריך, להחליף או לתבוע לפני שהאחריות פגה.</p>
    <a href="{app_url}" class="cta">פתח בקלסר ←</a>
    <div class="footer">
      קיבלת מייל זה כי הוספת מסמך עם תאריך תפוגת אחריות בקלסר.<br>
      ניתן לבטל תזכורות בהגדרות החשבון.
    </div>
  </div>
</body>
</html>
"""
    text = (
        f"תזכורת: האחריות על {doc_name} פגה {when} ({warranty_end}).\n"
        f"ימים נותרים: {days_left}.\n"
        f"פתח בקלסר: {app_url}\n"
    )
    return subject, html, text


def render_generic_reminder_email(
    name: str,
    reminder_type: str,
    remind_at: str,
    app_url: str = "https://gleaming-selkie-ccb973.netlify.app/#reminders",
) -> tuple[str, str, str]:
    """Returns (subject, html, text) for a generic user-created reminder."""
    type_emoji = {
        "birthday": "🎂", "anniv": "💍", "appt": "🏥",
        "periodic": "🔁", "warranty": "🛡️", "other": "📌",
    }.get(reminder_type, "🔔")
    type_label = {
        "birthday": "יום הולדת", "anniv": "יום שנה", "appt": "תור",
        "periodic": "תזכורת תקופתית", "warranty": "אחריות", "other": "תזכורת",
    }.get(reminder_type, "תזכורת")

    subject = f"{type_emoji} {name}"
    html = f"""
<!DOCTYPE html>
<html dir="rtl" lang="he">
<head><meta charset="utf-8">{_BASE_STYLE}</head>
<body>
  <div class="card">
    <div class="logo">📁 קלסר</div>
    <h1>{type_emoji} {type_label}</h1>
    <p><span class="doc-name">{name}</span></p>
    <div class="meta">
      <div class="meta-row"><span>סוג</span><b>{type_label}</b></div>
      <div class="meta-row"><span>תאריך</span><b>{remind_at}</b></div>
    </div>
    <a href="{app_url}" class="cta">פתח בקלסר ←</a>
    <div class="footer">תזכורת זו נשלחה אוטומטית מקלסר.</div>
  </div>
</body>
</html>
"""
    text = f"{type_label}: {name}\nתאריך: {remind_at}\nפתח בקלסר: {app_url}\n"
    return subject, html, text
