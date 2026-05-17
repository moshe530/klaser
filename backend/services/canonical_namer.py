"""
Canonical Namer — deterministic document-name construction.

The AI extractor is non-deterministic across calls. Even with strict
prompt templates, two invoices from the same merchant in different months
often get slightly different names ("חשבון בזק - מרץ 2025" vs
"בזק - חשבון סלולר - 03/2025"). For "similar documents look similar"
to hold, we override the AI's `name` with a deterministic value computed
from the extracted fields.

Strategy:
  1. Canonicalize the `merchant` string — strip corporate suffixes
     (בע"מ, ltd, inc, (2007)…), collapse whitespace, normalize Hebrew
     niqqud. This produces a stable key per real-world entity.
  2. Look up siblings for the same user: documents whose canonical
     merchant matches. If any exist, **reuse the sibling's `merchant`
     display string** so the user sees one consistent spelling.
  3. Build the name from a per-category template:
       invoice-like categories     → "{merchant} - {category} - {YYYY-MM}"
       payslip                     → "תלוש שכר - {employer} - {YYYY-MM}"
       car / property / personal   → leave AI's name as-is (already
                                     covered by strong prompt templates).

The override is **non-destructive**: callers decide whether to write it
based on `is_first_analysis` and whether the user has edited the name.
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date, datetime
from typing import Any, Optional

# ── Corporate suffixes (Hebrew + English) ──────────────────────────────
# These are stripped from the END of the merchant name before
# canonicalization. Order matters: longer phrases first to avoid leaving
# residue like " חברה" after "החברה הישראלית" is stripped.
_SUFFIX_PATTERNS = [
    r"\bהחברה\s+הישראלית\s+ל[\u0590-\u05FF\w\s]+$",
    r"\bבע\"?מ\b\.?",
    r"\bבעמ\b\.?",
    r"\bבע\u05F4מ\b\.?",         # Hebrew gershayim
    r"\bחב'\s",
    r"\bחברה\b",
    r"\(\s*\d{4}\s*\)",          # (2007), (1995)
    r"\(\s*ישראל\s*\)",
    r"\bisrael\b",
    r"\bltd\.?\b",
    r"\bllc\.?\b",
    r"\binc\.?\b",
    r"\bcorp\.?\b",
    r"\bplc\.?\b",
    r"\bgmbh\b",
    r"\b\(\s*\d{4}\s*\)\b",
]
_SUFFIX_RE = re.compile("|".join(_SUFFIX_PATTERNS), re.IGNORECASE)

# Hebrew niqqud range — stripped for comparison; left in display.
_NIQQUD_RE = re.compile(r"[\u0591-\u05C7]")
# Geresh / gershayim variations.
_GERESH_RE = re.compile(r"[\u05F3\u05F4]")
_WS_RE = re.compile(r"\s+")


def _strip_niqqud(s: str) -> str:
    return _NIQQUD_RE.sub("", _GERESH_RE.sub("'", s))


def canonicalize_merchant(name: Any) -> str:
    """Reduce a merchant string to a stable comparison key.

    Returns lowercased, niqqud-stripped, suffix-stripped, whitespace-
    collapsed text. Two display variants of the same entity map to the
    same canonical form — that's the property we rely on.

    Examples:
        "בזק - החברה הישראלית לתקשורת בע\"מ" → "בזק"
        "Bezeq International Ltd."             → "bezeq international"
        "Electra (2007) Ltd"                   → "electra"
    """
    if not name:
        return ""
    s = unicodedata.normalize("NFKC", str(name)).strip()
    s = _strip_niqqud(s)
    # Drop suffixes repeatedly — sometimes there's "בע"מ (2007)" stacked.
    prev = None
    while prev != s:
        prev = s
        s = _SUFFIX_RE.sub("", s).strip(" -–—,.\u00A0")
    s = _WS_RE.sub(" ", s).strip(" -–—,.")
    return s.lower()


# ── Period formatting helpers ──────────────────────────────────────────
def _parse_iso_date(v: Any) -> Optional[date]:
    if not v:
        return None
    if isinstance(v, date):
        return v
    if isinstance(v, datetime):
        return v.date()
    s = str(v).strip()
    # Accept "YYYY-MM-DD" or "YYYY-MM" (extend with day=01).
    for fmt in ("%Y-%m-%d", "%Y-%m", "%Y/%m/%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _month_label(d: date | None) -> str:
    """Return a YYYY-MM string. We deliberately use ISO-numeric instead of
    a localized month name ("מרץ 2025") because numbers sort naturally
    and never have spelling variants ("מארס" vs "מרץ")."""
    if not d:
        return ""
    return f"{d.year:04d}-{d.month:02d}"


def _year_label(d: date | None) -> str:
    if not d:
        return ""
    return str(d.year)


def _best_period(result: dict[str, Any]) -> tuple[date | None, date | None]:
    """Pick the most informative date for naming. Preference order:
    purchase_date → document_period.from → warranty_end.

    Exception: for categories where `purchase_date` and `document_period.from`
    typically refer to DIFFERENT real-world events (payslip: payment-date
    vs salary-month; recurring bills: due-date vs billing-period), prefer
    `document_period.from` because that's the period the document
    *describes*, which is what the user expects in the name."""
    category = (result.get("category") or "").strip()
    period = result.get("document_period") or {}
    period_from = _parse_iso_date(period.get("from")) if isinstance(period, dict) else None
    period_to   = _parse_iso_date(period.get("to"))   if isinstance(period, dict) else None
    purchase    = _parse_iso_date(result.get("purchase_date"))

    PERIOD_FIRST = {
        "תלוש שכר",  # purchase_date=payment, document_period=salary month
        "חשמל", "מים", "גז", "תקשורת",  # bills: due-date vs billing window
        "ארנונה", "ועד בית",
    }
    if category in PERIOD_FIRST and period_from:
        return period_from, period_to

    if purchase:
        return purchase, None
    if period_from or period_to:
        return period_from or period_to, period_to
    we = _parse_iso_date(result.get("warranty_end"))
    return we, None


# ── Category → name template mapping ────────────────────────────────────
# Categories where consistency matters the most (recurring bills).
# We use simple inline builders rather than format strings so each can
# customize fallback behavior.
RECURRING_BILL_CATEGORIES = {
    "חשמל", "מים", "גז", "תקשורת", "ארנונה", "ועד בית", "אינטרנט",
    "סלולר", "חשבוניות", "מוצרים",
}
WORK_CATEGORIES = {"תלוש שכר", "פנסיה"}
MEDICAL_CATEGORIES = {"רפואי"}


def _clean_for_name(s: Any, max_len: int = 40) -> str:
    """Trim and bound a string for use inside a name. Strips trailing
    punctuation that would look ugly in 'בזק. - חשמל - 2025-03'."""
    if not s:
        return ""
    out = unicodedata.normalize("NFKC", str(s)).strip(" -–—,.\u00A0")
    out = _WS_RE.sub(" ", out)
    if len(out) > max_len:
        out = out[:max_len].rstrip(" -–—,.") + "…"
    return out


def build_canonical_name(
    result: dict[str, Any],
    *,
    merchant_alias: str | None = None,
) -> str | None:
    """Produce a canonical name from extraction output. Returns None when
    no useful template applies — caller should keep the AI's `name`.

    Args:
        result: Extraction dict from the AI (must include category and
            ideally merchant + purchase_date + document_period).
        merchant_alias: If the caller already knows the user's preferred
            display string for this merchant (via sibling lookup), pass
            it in to override the AI's variant.
    """
    if not isinstance(result, dict):
        return None

    category = (result.get("category") or "").strip()
    if not category:
        return None

    merchant_raw = merchant_alias or result.get("merchant") or ""
    merchant = _clean_for_name(merchant_raw)
    period_from, period_to = _best_period(result)
    period_label = _month_label(period_from)
    year_label   = _year_label(period_from)

    # ── Recurring bills: strongest consistency requirement ─────────────
    if category in RECURRING_BILL_CATEGORIES:
        if not merchant and not period_label:
            return None
        if merchant and period_label:
            return f"{merchant} — {category} — {period_label}"
        if merchant:
            return f"{merchant} — {category}"
        # No merchant — fall through to AI name (better than "— X —").
        return None

    # ── Payslip: employer + month ──────────────────────────────────────
    if category in WORK_CATEGORIES:
        employer = _clean_for_name(result.get("merchant") or merchant_alias)
        if employer and period_label:
            return f"{category} — {employer} — {period_label}"
        if employer and year_label:
            return f"{category} — {employer} — {year_label}"
        return None

    # ── Medical: keep AI's name (per-doc variability is desired:
    #     "בדיקת דם", "תוצאות MRI", "מרשם" — different doc types). ────
    if category in MEDICAL_CATEGORIES:
        return None

    # ── Insurance / bank / credit: merchant + category + year ─────────
    if category in ("ביטוח", "בנק", "אשראי"):
        if merchant and year_label:
            return f"{merchant} — {category} — {year_label}"
        if merchant and period_label:
            return f"{merchant} — {category} — {period_label}"
        return None

    # Unknown category — defer to AI's name (already templated by prompt).
    return None


# ── Sibling-aware merchant alias picker ─────────────────────────────────
def pick_merchant_alias(
    candidate_merchant: str | None,
    sibling_docs: list[dict[str, Any]],
) -> str | None:
    """Given the AI's `merchant` and a list of the user's prior docs,
    return the **existing display variant** that matches the same
    canonical form. This is what makes "בזק" / "Bezeq" / "בזק בעמ"
    collapse to the very first spelling the user already has.

    Tie-breaker: the most-frequent display variant wins. If the candidate
    has no canonical match in the sibling list, we return None so the
    caller keeps the AI's spelling for the first occurrence.
    """
    canon = canonicalize_merchant(candidate_merchant or "")
    if not canon:
        return None
    counts: dict[str, int] = {}
    for d in sibling_docs:
        m = d.get("merchant")
        if not m:
            continue
        if canonicalize_merchant(m) == canon:
            counts[m] = counts.get(m, 0) + 1
    if not counts:
        return None
    # Most-frequent variant; stable tiebreak by alphabetic order.
    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
