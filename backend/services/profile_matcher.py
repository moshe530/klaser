"""
Profile Matcher — given a name + national-ID extracted from a document,
find the user's family-profile that the document most likely belongs to.

Returns a (profile, confidence) pair:
  - profile is the matched profile dict, or None if no reasonable match.
  - confidence is one of 'high' | 'medium' | 'low' | None.

Confidence semantics (mirrored in `documents.assignment_confidence` column
and used by the frontend to decide between silent auto-assign vs. banner
suggestion):

    high   = ID number matches exactly. Effectively certain. Auto-assigned
             with a quiet success toast.
    medium = Name matches strongly (full name or normalized Hebrew tokens)
             OR partial ID match. Profile_id is set but flagged
             `assignment_status='suggested'` so the UI shows a confirm
             banner.
    low    = Single-token / first-name-only match. NOT auto-assigned —
             only surfaced as a list of candidates when the user clicks
             "review unassigned".
    None   = no signal at all (no extracted name, no extracted id, or no
             configured profiles).

Design notes:
  - The matcher is intentionally conservative: ambiguity (>1 candidates
    with similar name score) collapses confidence to 'low' so we never
    silently auto-assign the wrong person.
  - Hebrew normalization strips niqqud, geresh/gershayim, and collapses
    whitespace before comparing, so "ד'נה" / "דנה" / " דנה  " all match.
  - Levenshtein is used as a tie-breaker for OCR noise (e.g. "דבה" → "דנה"
    when one character was misread) — only with a high threshold.
"""
from __future__ import annotations

import logging
import re
import unicodedata
from typing import Any

logger = logging.getLogger("klaser.profile_matcher")

# Hebrew niqqud (vowel marks) and combining-mark range — stripped before
# comparison so users typing "מַשֶׁה" still match a profile named "משה".
_NIQQUD_RE = re.compile(r"[\u0591-\u05C7]")
# Geresh / gershayim used for abbreviations (ת"ז) — collapse to nothing.
_GERESH_RE = re.compile(r"[\u05F3\u05F4'\"`]")
# Anything that isn't a Hebrew/Latin letter or digit — collapsed to space.
_NON_WORD_RE = re.compile(r"[^\u0590-\u05FFA-Za-z0-9]+")


# ── Confidence thresholds ────────────────────────────────────────────────
# Tuned for "high precision, low noise". When in doubt — downgrade.
NAME_HIGH_THRESHOLD = 0.92      # near-exact (handles 1-char OCR noise)
NAME_MEDIUM_THRESHOLD = 0.75    # strong but not certain
NAME_LOW_THRESHOLD = 0.55       # weak signal


# ────────────────────────────────────────────────────────────────────────
# ID-number helpers
# ────────────────────────────────────────────────────────────────────────
def _digits_only(s: Any) -> str:
    if not s:
        return ""
    return re.sub(r"\D", "", str(s))


def _id_match(extracted: str, profile_id: str) -> str | None:
    """Compare two ID numbers. Returns 'exact' / 'partial' / None.

    Profiles may store either the full 9-digit ID or the masked form
    "****1234" (legacy clients). For legacy masked profiles we can still
    do a useful partial match against the last 4 digits of the extracted
    ID — that's better than no match at all but not 'high' confidence.
    """
    a = _digits_only(extracted)
    b = _digits_only(profile_id)
    if not a or not b:
        return None
    if len(a) >= 5 and len(b) >= 5 and a == b:
        return "exact"
    # Last-4 partial match (handles legacy masked profiles "****1234").
    if len(a) >= 4 and len(b) >= 4 and a[-4:] == b[-4:]:
        return "partial"
    return None


# ────────────────────────────────────────────────────────────────────────
# Name normalization & similarity
# ────────────────────────────────────────────────────────────────────────
def _normalize_name(name: Any) -> str:
    """Lowercase, strip niqqud/geresh, collapse separators. Returns ''."""
    if not name:
        return ""
    s = unicodedata.normalize("NFKC", str(name))
    s = _NIQQUD_RE.sub("", s)
    s = _GERESH_RE.sub("", s)
    s = _NON_WORD_RE.sub(" ", s).strip().lower()
    s = re.sub(r"\s+", " ", s)
    return s


def _name_tokens(name: str) -> list[str]:
    return [t for t in _normalize_name(name).split(" ") if t]


def _levenshtein(a: str, b: str) -> int:
    """Classic O(len(a)*len(b)) edit distance. Both inputs are short
    (Hebrew names — ~10 chars), so the constant factor is fine."""
    if a == b:
        return 0
    if not a:
        return len(b)
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    curr = [0] * (len(b) + 1)
    for i, ca in enumerate(a, 1):
        curr[0] = i
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr[j] = min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
        prev, curr = curr, prev
    return prev[-1]


def _string_similarity(a: str, b: str) -> float:
    """Normalized similarity in [0.0, 1.0]. 1.0 = identical."""
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    dist = _levenshtein(a, b)
    longest = max(len(a), len(b))
    return 1.0 - (dist / longest)


def _name_similarity(extracted: str, profile_name: str) -> float:
    """Heuristic name similarity tuned for Hebrew family names.

    Strategy:
      1. Normalize both sides.
      2. If equal → 1.0.
      3. If extracted contains profile name as a substring (or vice
         versa) → 0.95. This handles "בדיקת דם — דנה כהן בת 8" where
         the doc has extra context.
      4. Token overlap with Levenshtein-allowed fuzz per token →
         ratio of matched tokens to max(tokens_a, tokens_b).
      5. Fallback: full-string normalized Levenshtein similarity.
    """
    a = _normalize_name(extracted)
    b = _normalize_name(profile_name)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0
    if b in a or a in b:
        return 0.95

    tokens_a = _name_tokens(a)
    tokens_b = _name_tokens(b)
    if tokens_a and tokens_b:
        # Each profile token: best similarity to any extracted token.
        per_token: list[float] = []
        for tb in tokens_b:
            best = max((_string_similarity(tb, ta) for ta in tokens_a), default=0.0)
            per_token.append(best)
        # We weigh by the profile-side tokens: a 2-word profile matched
        # by both words ranks higher than 1 of 3 doc tokens matching.
        if per_token:
            avg = sum(per_token) / len(per_token)
            # Bonus when *every* profile token has a good match —
            # captures "first + last name both present in doc".
            if all(s >= 0.8 for s in per_token):
                avg = max(avg, 0.9)
            return avg
    return _string_similarity(a, b)


# ────────────────────────────────────────────────────────────────────────
# Main entry point
# ────────────────────────────────────────────────────────────────────────
def match_profile(
    extracted_name: str | None,
    extracted_id: str | None,
    profiles: list[dict[str, Any]] | None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Pick the best-matching family profile for the extracted signals.

    Args:
        extracted_name: Raw person name parsed from the document by the AI
            (may include extra context like "Mrs." / age / institution).
        extracted_id:   Raw ID number from the document (digits only or
            decorated with ת.ז.; we strip non-digits internally).
        profiles:       Caller-supplied list of family profiles. Each
            profile dict should have at minimum {id, name}, and may
            include {id_number}.

    Returns:
        (profile_dict, confidence_str) where:
          - profile_dict is the matched profile, or None.
          - confidence_str is 'high' / 'medium' / 'low' / None.
    """
    if not profiles:
        return None, None

    extracted_name = (extracted_name or "").strip()
    extracted_id = _digits_only(extracted_id)

    if not extracted_name and not extracted_id:
        return None, None

    # ── Pass 1: exact ID match wins immediately ────────────────────────
    if extracted_id:
        for p in profiles:
            kind = _id_match(extracted_id, p.get("id_number") or "")
            if kind == "exact":
                return p, "high"
        # Partial ID matches are remembered but don't short-circuit —
        # we still want to verify name agreement. If only one profile
        # has a partial-ID match AND the name agrees → medium.

    # ── Pass 2: score every profile by name similarity ─────────────────
    if not extracted_name:
        # No name to score against — and we already failed the exact-ID
        # pass. Fall through to partial-ID-only consideration below.
        scored: list[tuple[dict[str, Any], float]] = []
    else:
        scored = [
            (p, _name_similarity(extracted_name, p.get("name") or ""))
            for p in profiles
        ]
        scored.sort(key=lambda x: x[1], reverse=True)

    best: dict[str, Any] | None = None
    best_score = 0.0
    second_score = 0.0
    if scored:
        best, best_score = scored[0]
        if len(scored) > 1:
            second_score = scored[1][1]

    # ── Pass 3: combine name + partial-ID signals ──────────────────────
    # If the top name match also happens to share the last 4 digits of
    # an ID, that's a strong corroboration → bump to high.
    if best and extracted_id and best.get("id_number"):
        kind = _id_match(extracted_id, best["id_number"])
        if kind == "partial" and best_score >= NAME_MEDIUM_THRESHOLD:
            return best, "high"
        if kind == "exact":
            return best, "high"

    # ── Pass 4: name-only confidence ladder ────────────────────────────
    # We require a margin over the runner-up to avoid silently picking
    # one of two equally-likely siblings.
    if best:
        margin = best_score - second_score
        if best_score >= NAME_HIGH_THRESHOLD and margin >= 0.10:
            return best, "high"
        if best_score >= NAME_MEDIUM_THRESHOLD and margin >= 0.05:
            return best, "medium"
        if best_score >= NAME_LOW_THRESHOLD:
            return best, "low"

    # ── Pass 5: as a last resort, surface a partial-ID match alone ─────
    # (covers the case where OCR garbled the name but the ID is mostly
    # readable). We treat this as 'low' — needs user confirmation.
    if extracted_id:
        for p in profiles:
            if _id_match(extracted_id, p.get("id_number") or "") == "partial":
                return p, "low"

    return None, None


# ────────────────────────────────────────────────────────────────────────
# Bulk helper — used by the "back-fill on new profile" endpoint.
# ────────────────────────────────────────────────────────────────────────
def find_documents_for_profile(
    profile: dict[str, Any],
    documents: list[dict[str, Any]],
    min_confidence: str = "medium",
) -> list[tuple[dict[str, Any], str]]:
    """Scan past documents for ones that likely belong to a newly-added
    profile. Returns a list of (document, confidence) pairs.

    Documents are expected to already have AI signals on them (either at
    the top level as `assignment_extracted_*` columns, or inside the
    `ai_data` JSON blob — we check both).
    """
    rank = {"high": 3, "medium": 2, "low": 1}
    threshold = rank.get(min_confidence, 2)
    out: list[tuple[dict[str, Any], str]] = []

    for d in documents:
        ai = d.get("ai_data") or {}
        name = (
            d.get("assignment_extracted_name")
            or ai.get("extracted_person_name")
            or ai.get("person")
        )
        # Prefer the full extracted ID from ai_data (better signal); fall
        # back to the last-4 column if ai_data was wiped.
        id_num = (
            ai.get("extracted_id_number")
            or d.get("assignment_extracted_id_last4")
        )
        if not name and not id_num:
            continue
        matched, conf = match_profile(name, id_num, [profile])
        if matched and conf and rank.get(conf, 0) >= threshold:
            out.append((d, conf))
    return out
