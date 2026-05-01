"""
Post-processing helpers for AI output.

The model usually returns clean values, but in practice:
  - amounts arrive as "1,200 ₪" / "1200.00 ש\"ח" / "₪ 12,345.67"
  - dates arrive as "12/03/2025", "9.7.25", "2025-3-12", "March 12, 2025"

These helpers turn them into something the DB can store directly.
All helpers are pure and tolerant: they NEVER raise — bad input → None.
"""
from __future__ import annotations

import re
from datetime import date
from typing import Any, Iterable, Optional

# ---------------------------------------------------------------------------
# Amounts
# ---------------------------------------------------------------------------
_AMOUNT_CLEAN_RE = re.compile(r"[^\d.\-]")  # strip everything except digits, dot, minus


def normalize_amount(value: Any) -> Optional[float]:
    """Convert messy AI output to a clean float, or None."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        f = float(value)
        return f if f == f else None  # NaN guard
    if not isinstance(value, str):
        return None

    s = value.strip()
    if not s:
        return None

    # Remove thousands separators first (commas only — dot is decimal).
    s = s.replace(",", "")
    # Strip currency symbols, letters, whitespace.
    s = _AMOUNT_CLEAN_RE.sub("", s)
    # Edge case: "-" alone or empty
    if s in ("", "-", ".", "-."):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def normalize_amount_list(values: Any) -> list[float]:
    """Apply normalize_amount across an iterable, dropping invalid entries."""
    if not isinstance(values, Iterable) or isinstance(values, (str, bytes)):
        return []
    out: list[float] = []
    for v in values:
        n = normalize_amount(v)
        if n is not None:
            out.append(n)
    return out


# ---------------------------------------------------------------------------
# Dates
# ---------------------------------------------------------------------------
# Accept the common Israeli/European spellings the AI might produce.
_DATE_PATTERNS: list[tuple[re.Pattern[str], tuple[str, str, str]]] = [
    # 2025-03-12 / 2025/3/12
    (re.compile(r"^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$"), ("y", "m", "d")),
    # 12/03/2025 / 12-3-2025 / 12.3.2025  (DMY — Israeli convention)
    (re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$"), ("d", "m", "y")),
    # 9.7.25  → 2025-07-09  (DMY two-digit year)
    (re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$"),  ("d", "m", "yy")),
]


def normalize_date(value: Any) -> Optional[str]:
    """Return a YYYY-MM-DD string or None. Never raises."""
    if value is None:
        return None
    if isinstance(value, date):
        return value.isoformat()
    if not isinstance(value, str):
        return None

    s = value.strip()
    if not s:
        return None

    # Already canonical?
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return s

    for pattern, order in _DATE_PATTERNS:
        m = pattern.match(s)
        if not m:
            continue
        parts = dict(zip(order, m.groups()))
        try:
            year = parts.get("y") or _two_digit_year(parts["yy"])
            month = int(parts["m"])
            day = int(parts["d"])
            d = date(int(year), month, day)
            return d.isoformat()
        except (ValueError, KeyError):
            continue

    return None


def _two_digit_year(yy: str) -> str:
    """Heuristic: 70..99 → 1970..1999, 00..69 → 2000..2069."""
    n = int(yy)
    return str(1900 + n) if n >= 70 else str(2000 + n)


# ---------------------------------------------------------------------------
# Enums (clamp model output to allowed values)
# ---------------------------------------------------------------------------
def clamp_enum(value: Any, allowed: Iterable[str], *, default: Optional[str] = None) -> Optional[str]:
    """If value is in `allowed`, return it; otherwise return default."""
    allowed_set = set(allowed)
    if isinstance(value, str) and value in allowed_set:
        return value
    return default
