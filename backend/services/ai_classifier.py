"""
Classifier — small, fast vision call.

Single job: identify the *type* of document + quality signals.
Does NOT extract amounts/dates — that's the Extractor's job.

Input:  list of image data-URLs (rendered pages).
Output: dict with {doc_type_detected, confidence, confidence_reason,
        needs_review, ocr_quality, language, structure}.

Uses the full ~100-type taxonomy from v4.0 so the Extractor can apply
type-specific rules in the next stage.
"""
from __future__ import annotations

import json
from typing import Any

from . import groq_vision
from .normalize import clamp_enum

# Canonical list of all doc types the Classifier is allowed to return.
# Kept in sync with the prompt taxonomy below. Used by the pipeline to
# clamp model output: anything not in this set is rewritten to "אחר".
DOC_TYPES: frozenset[str] = frozenset({
    # שכר ותעסוקה
    "תלוש_שכר", "חוזה_עבודה", "אישור_העסקה", "מכתב_פיטורים",
    "פיצויי_פיטורים", "טופס_161", "מכתב_התפטרות", "בונוס_מענק", "טופס_106",
    # חשבוניות ורכישות
    "חשבונית_מס", "קבלה", "חשבונית_מס_קבלה", "תעודת_אחריות",
    "הצעת_מחיר", "הזמנת_רכש", "תעודת_משלוח",
    # בנק ואשראי
    "דף_חשבון_בנק", "אישור_ניהול_חשבון", "דוח_יתרות_שנתי",
    "מכתב_התראה_בנק", "הלוואה_חוזה", "לוח_סילוקין_הלוואה",
    "אישור_יתרה_לסילוק_משכנתא", "משכנתא", "פירוט_כרטיס_אשראי",
    "אישור_עסקה_אשראי", "זיכוי_החזר", "הוראת_קבע", "ערבות_בנקאית",
    # חיסכון ופנסיה
    "קרן_פנסיה", "קרן_השתלמות", "ביטוח_מנהלים", "קופת_גמל",
    "דוח_שנתי_קרן", "אישור_הפקדות",
    # מיסוי
    "שומת_מס", "החזר_מס", "אישור_ניכוי_מס_במקור", "דוח_שנתי_מס",
    "מעמ_תקופתי", "מקדמות_מס", "אישור_עוסק_מורשה",
    "חשבונית_עוסק_פטור", "אישור_תרומות_סעיף_46", "אישור_היעדר_חובות_מס",
    # ביטוח לאומי
    "ביטל_גמלה_כללית", "ביטל_דמי_לידה", "ביטל_אבטלה", "ביטל_נכות",
    "ביטל_קצבת_ילדים", "ביטל_זקנה_שארים", "ביטל_תאונת_עבודה", "שירות_תעסוקה",
    # ביטוח
    "ביטוח_רכב_מקיף", "ביטוח_רכב_חובה", "ביטוח_דירה", "ביטוח_חיים",
    "ביטוח_בריאות", "ביטוח_נסיעות", "ביטוח_עסק", "ביטוח_אחריות",
    "תעודת_ביטוח", "דוח_תביעה_ביטוח", "אישור_העדר_תביעות",
    # נדלן ודיור
    "חוזה_שכירות", "חוזה_קניית_דירה", "נסח_טאבו", "שטר_מכר",
    "הערת_אזהרה", "היתר_בנייה", "שמאות", "ארנונה", "היטל_השבחה",
    "אישור_היעדר_חובות_עיריה", "ועד_בית_חשבון", "חוזה_ניהול_בניין",
    "פרוטוקול_ועד_בית", "הסכם_שיתוף_שכנים",
    # רכב ותחבורה
    "רישיון_רכב", "טסט_רכב", "רישיון_נהיגה", "חוזה_קניית_רכב",
    "ליסינג_רכב", "קבלת_מוסך", "העברת_בעלות_רכב",
    "אישור_הפקדת_רישיון", "קנס_תנועה", "דוח_חניה",
    "פסק_דין_תעבורה", "אישור_קורס_נהיגה",
    # רפואי
    "סיכום_רפואי", "מרשם", "תוצאות_בדיקות", "הפניה_רופא",
    "טופס_17", "חשבון_קופת_חולים", "תביעת_ביטוח_רפואי",
    "תוצאות_דם", "צילום_רנטגן_MRI", "אישור_מחלה",
    # חינוך
    "אישור_לימודים", "תעודת_בגרות", "תואר_אקדמי", "גיליון_ציונים",
    "מלגה", "שכר_לימוד", "קורס_הכשרה", "אישור_התנדבות", "אישור_שירות",
    # אישי ומשפחה
    "תעודת_זהות", "דרכון", "ספח_תעודת_זהות", "תעודת_לידה",
    "תעודת_נישואין", "תעודת_גירושין", "הסכם_משמורת",
    "צוואה", "צו_ירושה", "ייפוי_כוח", "הסכם_ממון", "אישור_תושבות",
    # משפטי ועסקי
    "חוזה_כללי", "הסכם_שירות", "הסכם_סודיות_NDA", "פסק_דין",
    "כתב_תביעה", "הסכם_פשרה", "רישיון_עסק", "תקנון_חברה",
    "אישור_רשם_חברות", "ייפוי_כוח_עסקי",
    # תקשורת ודיגיטל
    "חשבון_סלולר", "חשבון_אינטרנט", "חשבון_כבלים_לוין",
    "מנוי_שירות_דיגיטלי", "קבלת_חנות_אפליקציות",
    # חשבונות שירות
    "חשבון_חשמל", "חשבון_מים", "חשבון_גז", "חשבון_ארנונה",
    # ייבוא ומשלוחים
    "שחרור_מכס", "חשבון_משלוח_בינלאומי", "שטר_מטען", "אישור_יבוא",
    # אחר
    "מכתב_רשמי", "אחר",
})

CONFIDENCE_VALUES   = ("high", "medium", "low")
OCR_QUALITY_VALUES  = ("high", "medium", "low")
LANGUAGE_VALUES     = ("he", "en", "mixed")
STRUCTURE_VALUES    = ("table", "form", "free_text", "mixed")


CLASSIFIER_PROMPT = """אתה מסווג מסמכים עבור מערכת קלסר דיגיטלי.
החזר JSON בלבד, ללא טקסט נוסף ובלי ```.

מטרתך: לזהות סוג מסמך אחד בלבד + להעריך איכות.
אסור להחליט על סוג שלא ברשימה — אם לא בטוח, החזר "אחר" עם confidence=low.

══ שלב 1: זיהוי סוג מסמך ══

בחר אחד בלבד מהרשימה (כתוב בדיוק את המחרוזת, כולל קווים תחתונים):

--- שכר ותעסוקה ---
תלוש_שכר | חוזה_עבודה | אישור_העסקה | מכתב_פיטורים |
פיצויי_פיטורים | טופס_161 | מכתב_התפטרות | בונוס_מענק | טופס_106

--- חשבוניות ורכישות ---
חשבונית_מס | קבלה | חשבונית_מס_קבלה | תעודת_אחריות |
הצעת_מחיר | הזמנת_רכש | תעודת_משלוח

--- בנק ואשראי ---
דף_חשבון_בנק | אישור_ניהול_חשבון | דוח_יתרות_שנתי |
מכתב_התראה_בנק | הלוואה_חוזה | לוח_סילוקין_הלוואה |
אישור_יתרה_לסילוק_משכנתא | משכנתא | פירוט_כרטיס_אשראי |
אישור_עסקה_אשראי | זיכוי_החזר | הוראת_קבע | ערבות_בנקאית

--- חיסכון ופנסיה ---
קרן_פנסיה | קרן_השתלמות | ביטוח_מנהלים | קופת_גמל |
דוח_שנתי_קרן | אישור_הפקדות

--- מיסוי ---
שומת_מס | החזר_מס | אישור_ניכוי_מס_במקור | דוח_שנתי_מס |
מעמ_תקופתי | מקדמות_מס | אישור_עוסק_מורשה |
חשבונית_עוסק_פטור | אישור_תרומות_סעיף_46 | אישור_היעדר_חובות_מס

--- ביטוח לאומי ---
ביטל_גמלה_כללית | ביטל_דמי_לידה | ביטל_אבטלה | ביטל_נכות |
ביטל_קצבת_ילדים | ביטל_זקנה_שארים | ביטל_תאונת_עבודה | שירות_תעסוקה

--- ביטוח ---
ביטוח_רכב_מקיף | ביטוח_רכב_חובה | ביטוח_דירה | ביטוח_חיים |
ביטוח_בריאות | ביטוח_נסיעות | ביטוח_עסק | ביטוח_אחריות |
תעודת_ביטוח | דוח_תביעה_ביטוח | אישור_העדר_תביעות

--- נדלן ודיור ---
חוזה_שכירות | חוזה_קניית_דירה | נסח_טאבו | שטר_מכר |
הערת_אזהרה | היתר_בנייה | שמאות | ארנונה | היטל_השבחה |
אישור_היעדר_חובות_עיריה | ועד_בית_חשבון | חוזה_ניהול_בניין |
פרוטוקול_ועד_בית | הסכם_שיתוף_שכנים

--- רכב ותחבורה ---
רישיון_רכב | טסט_רכב | רישיון_נהיגה | חוזה_קניית_רכב |
ליסינג_רכב | קבלת_מוסך | העברת_בעלות_רכב |
אישור_הפקדת_רישיון | קנס_תנועה | דוח_חניה |
פסק_דין_תעבורה | אישור_קורס_נהיגה

--- רפואי ---
סיכום_רפואי | מרשם | תוצאות_בדיקות | הפניה_רופא |
טופס_17 | חשבון_קופת_חולים | תביעת_ביטוח_רפואי |
תוצאות_דם | צילום_רנטגן_MRI | אישור_מחלה

--- חינוך ---
אישור_לימודים | תעודת_בגרות | תואר_אקדמי | גיליון_ציונים |
מלגה | שכר_לימוד | קורס_הכשרה | אישור_התנדבות | אישור_שירות

--- אישי ומשפחה ---
תעודת_זהות | דרכון | ספח_תעודת_זהות | תעודת_לידה |
תעודת_נישואין | תעודת_גירושין | הסכם_משמורת |
צוואה | צו_ירושה | ייפוי_כוח | הסכם_ממון | אישור_תושבות

--- משפטי ועסקי ---
חוזה_כללי | הסכם_שירות | הסכם_סודיות_NDA | פסק_דין |
כתב_תביעה | הסכם_פשרה | רישיון_עסק | תקנון_חברה |
אישור_רשם_חברות | ייפוי_כוח_עסקי

--- תקשורת ודיגיטל ---
חשבון_סלולר | חשבון_אינטרנט | חשבון_כבלים_לוין |
מנוי_שירות_דיגיטלי | קבלת_חנות_אפליקציות

--- חשבונות שירות ---
חשבון_חשמל | חשבון_מים | חשבון_גז | חשבון_ארנונה

--- ייבוא ומשלוחים ---
שחרור_מכס | חשבון_משלוח_בינלאומי | שטר_מטען | אישור_יבוא

--- אחר ---
מכתב_רשמי | אחר

══ שלב 2: הערכת איכות ══

ocr_quality: high | medium | low
language:    he | en | mixed
structure:   table | form | free_text | mixed

══ שלב 3: ביטחון ══

confidence: high | medium | low
confidence_reason: הסבר קצר (משפט אחד)
needs_review = true אם:
  - confidence = low
  - OCR חלש (ocr_quality = low)
  - סוג מסמך לא ברור / מסמך מעורב

══ פורמט פלט (JSON בלבד) ══

{
  "doc_type_detected": "string מהרשימה למעלה — בדיוק כפי שכתוב",
  "confidence": "high|medium|low",
  "confidence_reason": "string",
  "needs_review": true_or_false,
  "ocr_quality": "high|medium|low",
  "language": "he|en|mixed",
  "structure": "table|form|free_text|mixed"
}
"""


def _empty_classification(reason: str = "JSON parse failed") -> dict[str, Any]:
    return {
        "doc_type_detected": "אחר",
        "confidence":        "low",
        "confidence_reason": reason,
        "needs_review":      True,
        "ocr_quality":       "low",
        "language":          "unknown",
        "structure":         "unknown",
    }


def classify(image_urls: list[str]) -> dict[str, Any]:
    """Run the Classifier vision call. Always returns a full skeleton dict
    with values clamped to the allowed enums."""
    try:
        raw = groq_vision.call_vision(
            CLASSIFIER_PROMPT,
            image_urls,
            max_tokens=512,
            stage="classifier",
        )
    except Exception as e:  # network / api / config (after retries)
        return _empty_classification(reason=f"classifier call failed: {e}")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return _empty_classification(reason="invalid JSON from classifier")

    # Merge over skeleton so missing fields keep safe defaults.
    out = _empty_classification(reason=data.get("confidence_reason") or "")
    out.update({k: v for k, v in data.items() if v is not None})

    # Validate / clamp every field — never trust the model.
    detected = out.get("doc_type_detected")
    if not isinstance(detected, str) or detected not in DOC_TYPES:
        out["doc_type_detected"] = "אחר"
        out["confidence"] = "low"
        out["confidence_reason"] = (
            f"unknown doc_type from model: {detected!r}"
            if detected else "model returned no doc_type"
        )
        out["needs_review"] = True

    out["confidence"]   = clamp_enum(out.get("confidence"),   CONFIDENCE_VALUES,  default="low")
    out["ocr_quality"]  = clamp_enum(out.get("ocr_quality"),  OCR_QUALITY_VALUES, default="low")
    out["language"]     = clamp_enum(out.get("language"),     LANGUAGE_VALUES,    default="unknown")
    out["structure"]    = clamp_enum(out.get("structure"),    STRUCTURE_VALUES,   default="unknown")
    out["needs_review"] = bool(out.get("needs_review"))

    return out
