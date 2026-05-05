"""
Admin endpoints — protected by CRON_SECRET, NOT user JWT.

Used by GitHub Actions / external cron to trigger maintenance jobs.
"""
from __future__ import annotations

import logging
import secrets

from fastapi import APIRouter, Header, HTTPException, status

from ..config import settings
from ..services.reminder_scanner import run_scan

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["admin"])


def _require_cron_secret(x_cron_secret: str | None) -> None:
    if not settings.CRON_SECRET:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="CRON_SECRET not configured on server",
        )
    # Constant-time comparison to prevent timing attacks against CRON_SECRET.
    if not x_cron_secret or not secrets.compare_digest(
        x_cron_secret, settings.CRON_SECRET
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing X-Cron-Secret",
        )


@router.post("/scan-reminders")
def scan_reminders(x_cron_secret: str | None = Header(default=None, alias="X-Cron-Secret")):
    """Scan & send all due reminders (warranty + manual). Returns counts."""
    _require_cron_secret(x_cron_secret)
    try:
        summary = run_scan()
        return {"ok": True, **summary}
    except Exception as e:
        logger.exception("scan-reminders failed")
        raise HTTPException(500, f"Scan failed: {e}")
