"""
Extractor — heavy vision call that pulls structured fields from the document.

Receives the document images PLUS the type already determined by the Classifier
so it can be more precise (no re-classification).

Ships the full v4.0 per-type rule set (~30 doc-type-specific extraction blocks)
plus the v4.1 additional fields (amount_candidates, amount_labels,
document_period, merchant, document_type) and the strict amount/date
extraction algorithm.
"""
from __future__ import annotations

import json
from typing import Any

from . import groq_vision
from .normalize import (
    clamp_enum,
    normalize_amount,
    normalize_amount_list,
    normalize_date,
)

CATEGORIES = [
    "מוצרים",
    "ביטוח",
    "דירה",
    "רכב",
    "מסמכים אישיים",
    "חשמל",
    "גז",
    "מים",
    "תלוש שכר",
    "רפואי",
    "בנק",
    "אשראי",
    "אישורים",
    "פנסיה",
    "מיסים",
    "משפטי",
    "חינוך",
    "תקשורת",
    "אחר",
]


EXTRACTOR_PROMPT_TEMPLATE = f"""אתה מחלץ מידע ממסמך עבור מערכת קלסר דיגיטלי.
אתה מקבל מסמך + סוג מסמך שזוהה מראש על ידי Classifier (doc_type_detected).
החזר JSON תקין יחיד בלבד, ללא טקסט נוסף ובלי ```.

עקרונות עליונים:
- null עדיף מניחוש — אם שדה לא מופיע בבירור → null.
- אל תשנה ואל תזהה מחדש את סוג המסמך.
- דיוק לפני שלמות.

══ שלב 0: ניתוח מבנה (PREPROCESSING) ══

בדוק לפני הכל:
- סוג מבנה: טבלה / טופס / טקסט חופשי / מעורב.
- האם יש אזור "סהכ לתשלום" ברור?
- אם רב-עמודי: התמקד בעמוד עם "סהכ" / עמוד אחרון. התעלם מנספחים.

══ שלב 1: חילוץ לפי סוג המסמך ══

[תלוש_שכר]:
  name: "[מעסיק] - תלוש שכר [חודש שנה]"
  amount: שכר ברוטו לתשלום (המספר הגדול — לא הנטו!)
  purchase_date: תאריך חודש השכר
  document_period: {{ from: "YYYY-MM-01", to: "YYYY-MM-28/30/31" }}
  summary: "מעסיק: X | עובד: Y | ברוטו: Z | נטו: W | חודש: V"

[חשבונית_מס / קבלה / חשבונית_מס_קבלה / חשבונית_עוסק_פטור]:
  name: "[ספק] - [סוג] - [תאריך]"
  amount: סהכ לתשלום כולל מעמ (המספר הגדול מכל הסהכים!)
  purchase_date: תאריך החשבונית
  summary: "ספק: X | סכום: Y | מס חשבונית: Z"

[דף_חשבון_בנק / דוח_יתרות_שנתי / אישור_ניהול_חשבון]:
  name: "[בנק] - חשבון [4 ספרות אחרונות] - [תאריך]"
  amount: יתרה סופית (לא סכום תנועה בודדת!)
  purchase_date: תאריך הדף
  document_period: {{ from, to }}
  summary: "בנק: X | יתרה: Y | מספר תנועות: Z"

[הלוואה_חוזה / משכנתא / לוח_סילוקין_הלוואה / אישור_יתרה_לסילוק_משכנתא]:
  name: "[בנק] - [סוג] - [תאריך]"
  amount: סכום ההלוואה המקורי
  purchase_date: תאריך לקיחת ההלוואה
  warranty_end: תאריך סיום ההלוואה
  summary: "סכום: X | ריבית: Y | תקופה: Z | תשלום חודשי: W"

[קרן_פנסיה / קרן_השתלמות / ביטוח_מנהלים / קופת_גמל / דוח_שנתי_קרן]:
  name: "[חברה] - [סוג קרן] - [תאריך דוח]"
  amount: יתרה נצברת נוכחית (לא הפקדה חודשית!)
  purchase_date: תאריך הדוח
  summary: "חברה: X | עמית: Y | יתרה: Z | הפקדה חודשית: W"

[פירוט_כרטיס_אשראי / אישור_עסקה_אשראי]:
  name: "[חברת אשראי] - [4 ספרות] - [חודש שנה]"
  amount: סהכ לחיוב בחודש
  purchase_date: תאריך הדף
  document_period: {{ from, to }}
  summary: "כרטיס: X | לחיוב: Y | מספר עסקאות: Z"

[שומת_מס / החזר_מס / דוח_שנתי_מס / טופס_106]:
  name: "[רשות מיסים] - [סוג] - [שנת מס]"
  amount: סכום לתשלום/להחזר (יכול להיות שלילי!)
  purchase_date: תאריך הטופס
  summary: "שנת מס: X | סכום: Y | מצב: לתשלום/להחזר"

[מעמ_תקופתי / מקדמות_מס]:
  name: "[עוסק] - [סוג] - [תקופה]"
  amount: סכום לתשלום
  purchase_date: תאריך הגשה
  document_period: {{ from, to }}
  summary: "תקופה: X | מחזור: Y | לתשלום: Z"

[ביטל_גמלה_כללית / ביטל_דמי_לידה / ביטל_אבטלה / ביטל_נכות / ביטל_קצבת_ילדים / ביטל_זקנה_שארים / ביטל_תאונת_עבודה]:
  name: "ביטוח לאומי - [סוג גמלה] - [תאריך]"
  amount: סכום הגמלה
  purchase_date: תאריך האישור
  document_period: {{ from, to }}
  summary: "סוג: X | תקופה: Y | מס סימוכין: Z | סכום: W"

[ביטוח_רכב_מקיף / ביטוח_רכב_חובה / ביטוח_דירה / ביטוח_חיים / ביטוח_בריאות / ביטוח_עסק / ביטוח_אחריות]:
  name: "[חברת ביטוח] - פוליסת [סוג] - [שנה]"
  amount: פרמיה שנתית
  purchase_date: תאריך תחילת הפוליסה
  warranty_end: תאריך סיום הפוליסה (חובה!)
  document_period: {{ from: תחילה, to: סיום }}
  summary: "מבטח: X | מבוטח: Y | פוליסה: Z | תוקף: W"

[ביטוח_נסיעות]:
  name: "[חברה] - ביטוח נסיעות - [יעד] - [תאריך]"
  amount: פרמיה
  purchase_date: תאריך יציאה
  warranty_end: תאריך חזרה
  document_period: {{ from: יציאה, to: חזרה }}
  summary: "יעד: X | תקופה: Y | מבוטח: Z"

[חוזה_שכירות]:
  name: "חוזה שכירות - [כתובת] - [תאריך]"
  amount: שכר דירה חודשי
  purchase_date: תאריך תחילת השכירות
  warranty_end: תאריך סיום השכירות
  document_period: {{ from: תחילה, to: סיום }}
  summary: "כתובת: X | שוכר: Y | משכיר: Z | תקופה: W"

[חוזה_קניית_דירה / שטר_מכר / נסח_טאבו]:
  name: "[סוג] - [כתובת] - [תאריך]"
  amount: מחיר הדירה / שווי הנכס
  purchase_date: תאריך העסקה
  summary: "כתובת: X | קונה: Y | מוכר: Z | מחיר: W"

[ארנונה / חשבון_ארנונה / היטל_השבחה / אישור_היעדר_חובות_עיריה]:
  name: "[עיריה] - ארנונה - [שנה]"
  amount: סהכ שנתי / לתשלום
  purchase_date: תאריך ההודעה
  document_period: {{ from: "YYYY-01-01", to: "YYYY-12-31" }}
  summary: "עיריה: X | כתובת: Y | שנה: Z | לתשלום: W"

[רישיון_רכב / טסט_רכב]:
  name: "[סוג] - [מספר רכב] - [שנה]"
  amount: אגרה ששולמה
  purchase_date: תאריך הרישיון/הטסט
  warranty_end: תאריך פקיעת תוקף
  summary: "רכב: X | בעלים: Y | תוקף: Z"

[קנס_תנועה / דוח_חניה]:
  name: "[גורם מפקח] - קנס - [תאריך]"
  amount: סכום הקנס
  purchase_date: תאריך הקנס
  summary: "עבירה: X | רכב: Y | סכום: Z | לתשלום עד: W"

[קבלת_מוסך]:
  name: "[מוסך] - טיפול - [תאריך]"
  amount: סהכ לתשלום (כולל מעמ)
  purchase_date: תאריך הטיפול
  summary: "מוסך: X | רכב: Y | טיפולים: Z | סכום: W"

[סיכום_רפואי / הפניה_רופא / אישור_מחלה]:
  name: "[מוסד רפואי] - [סוג] - [תאריך]"
  amount: null (אלא אם יש חיוב כספי מפורש)
  purchase_date: תאריך הביקור
  summary: "מוסד: X | רופא: Y | אבחנה/המלצה: Z"

[מרשם]:
  name: "[רופא/קופה] - מרשם - [תאריך]"
  amount: null
  purchase_date: תאריך המרשם
  warranty_end: תאריך תפוגת המרשם (אם מופיע)
  summary: "רופא: X | תרופות: Y | מינון: Z"

[תוצאות_בדיקות / תוצאות_דם / צילום_רנטגן_MRI]:
  name: "[מוסד] - [סוג בדיקה] - [תאריך]"
  amount: null
  purchase_date: תאריך הבדיקה
  summary: "בדיקה: X | מוסד: Y | תוצאה כללית: Z"

[חשבון_קופת_חולים / טופס_17 / תביעת_ביטוח_רפואי]:
  name: "[קופה/מבטח] - [סוג] - [תאריך]"
  amount: סכום לחיוב/החזר (כולל מעמ)
  purchase_date: תאריך הטופס
  summary: "קופה: X | סוג: Y | סכום: Z"

[חשבון_חשמל / חשבון_מים / חשבון_גז]:
  name: "[ספק] - חשבון [סוג] - [חודש שנה]"
  amount: סהכ לתשלום כולל מעמ (לא סכום ביניים!)
  purchase_date: תאריך לתשלום (לא תאריך הנפקה)
  document_period: {{ from, to }}
  summary: "ספק: X | תקופה: Y | צריכה: Z | לתשלום: W"

[חשבון_סלולר / חשבון_אינטרנט / חשבון_כבלים_לוין / מנוי_שירות_דיגיטלי]:
  name: "[ספק] - חשבון [סוג] - [חודש שנה]"
  amount: סהכ לתשלום (כולל מעמ)
  purchase_date: תאריך החשבון
  document_period: {{ from, to }}
  summary: "ספק: X | תוכנית: Y | לתשלום: Z"

[שכר_לימוד / מלגה / קורס_הכשרה]:
  name: "[מוסד] - [סוג] - [שנה]"
  amount: סכום שכ\"ל / מלגה
  purchase_date: תאריך החיוב/האישור
  summary: "מוסד: X | שם: Y | סכום: Z | תקופה: W"

[פסק_דין / כתב_תביעה / הסכם_פשרה / פסק_דין_תעבורה]:
  name: "[בית משפט/צד] - [סוג] - [תאריך]"
  amount: סכום פסיקה (יכול להיות שלילי — שמור סימן!)
  purchase_date: תאריך המסמך
  summary: "צדדים: X | עניין: Y | סכום: Z | תוצאה: W"

[שחרור_מכס / חשבון_משלוח_בינלאומי / שטר_מטען / אישור_יבוא]:
  name: "[חברת משלוח] - [סוג] - [תאריך]"
  amount: סהכ לתשלום כולל מכס
  purchase_date: תאריך השחרור
  summary: "ספק: X | מוצר: Y | מכס: Z | סהכ: W"

[תעודת_אחריות]:
  name: "אחריות [מוצר] - [יצרן] - תפוגה [שנה]"
  amount: null (אלא אם יש מחיר רכישה ברור)
  purchase_date: תאריך הרכישה
  warranty_end: תאריך סיום האחריות (חובה!)
  summary: "מוצר: X | יצרן: Y | תפוגה: Z"

[הצעת_מחיר / הזמנת_רכש / תעודת_משלוח]:
  name: "[ספק] - [סוג] - [תאריך]"
  amount: סהכ ההצעה / ההזמנה (כולל מעמ אם מופיע)
  purchase_date: תאריך המסמך
  summary: "ספק: X | פריטים: Y | סכום: Z"

[ועד_בית_חשבון]:
  name: "ועד בית [כתובת] - [חודש שנה]"
  amount: סכום החיוב החודשי
  purchase_date: תאריך החיוב
  document_period: {{ from, to }}
  summary: "כתובת: X | תקופה: Y | סכום: Z"

[חוזה_עבודה / אישור_העסקה / מכתב_פיטורים / מכתב_התפטרות / פיצויי_פיטורים / טופס_161 / בונוס_מענק]:
  name: "[מעסיק] - [סוג] - [תאריך]"
  amount: סכום שכר/פיצוי (אם מופיע)
  purchase_date: תאריך תחילת/סיום העסקה
  summary: "עובד: X | מעסיק: Y | תפקיד: Z | סכום: W"

[רישיון_עסק / תקנון_חברה / אישור_רשם_חברות / ייפוי_כוח_עסקי / חוזה_כללי / הסכם_שירות / הסכם_סודיות_NDA]:
  name: "[צד/חברה] - [סוג] - [תאריך]"
  amount: סכום החוזה (אם מופיע)
  purchase_date: תאריך החתימה
  warranty_end: תאריך סיום (אם מופיע)
  summary: "צדדים: X | עניין: Y | תקופה: Z"

[תעודת_זהות / דרכון / ספח_תעודת_זהות / רישיון_נהיגה]:
  name: "[סוג מסמך] - [שם] - תפוגה [שנה]"
  amount: null
  purchase_date: תאריך הנפקה
  warranty_end: תאריך פקיעת תוקף
  summary: "סוג: X | שם: Y | מספר: Z | תוקף: W"

[תעודת_לידה / תעודת_נישואין / תעודת_גירושין / הסכם_משמורת / צוואה / צו_ירושה / ייפוי_כוח / הסכם_ממון]:
  name: "[סוג] - [שמות] - [תאריך]"
  amount: null
  purchase_date: תאריך המסמך
  summary: "סוג: X | צדדים: Y | פרטים: Z"

[תעודת_בגרות / תואר_אקדמי / גיליון_ציונים / אישור_לימודים / אישור_שירות / אישור_התנדבות]:
  name: "[מוסד] - [סוג] - [שנה]"
  amount: null
  purchase_date: תאריך ההנפקה
  summary: "מוסד: X | שם: Y | תוצאה/תפקיד: Z"

[אישור_עוסק_מורשה / אישור_ניכוי_מס_במקור / אישור_היעדר_חובות_מס / אישור_תרומות_סעיף_46 / אישור_תושבות / אישור_הפקדות]:
  name: "[רשות/גוף] - [סוג אישור] - [תאריך]"
  amount: null (אלא אם זה אישור על סכום)
  purchase_date: תאריך ההנפקה
  warranty_end: תוקף האישור (אם מופיע)
  summary: "סוג: X | מקבל: Y | תוקף: Z"

[מכתב_רשמי / אחר / general]:
  name: "[שולח] - [נושא] - [תאריך]"
  amount: null אלא אם יש סכום מובהק לתשלום
  purchase_date: תאריך המכתב
  summary: "שולח: X | נושא: Y | פעולה נדרשת: Z"

══ שלב 2: כללי זהב ══

1. null על פני ניחוש: אם שדה לא מופיע בבירור → null.

2. תאריכים: YYYY-MM-DD בלבד.
   "12/03/2025" → "2025-03-12" | "9.7.25" → "2025-07-09".
   אם יש רק תקופה (למשל "01/02/2026 - 01/03/2026") — ל-purchase_date בחר את **תאריך הסיום**.

3. amount — תמיד "סהכ לתשלום" הסופי. עקוב אחרי האלגוריתם:
   שלב א: זהה את כל השורות עם "סה\"כ" / "סך הכל" / "Total" / "יתרה לתשלום".
   שלב ב: בחר את השורה שמכילה "כולל מע\"מ" / "לתשלום" / "לתקופת החשבון".
   שלב ג: בחשבונית עם 3 שורות — אסור לבחור את "סה\"כ ללא מע\"מ" או "סה\"כ מע\"מ".
     סה\"כ ללא מע\"מ:    574.48    ← אסור!
     סה\"כ מע\"מ:        103.41    ← אסור!
     סה\"כ כולל מע\"מ:   677.89    ← זה הנכון! ✓
   שלב ד: בדיקה עצמית — האם זה הגדול ביותר עם המילה "כולל"/"לתשלום"?
   שלב ה: פורמט: רק מספר עשרוני, ללא ₪/ש\"ח/פסיקים. דוגמה: 1037.28.

   חוקי-משנה לפי סוג:
     תלוש שכר   → ברוטו (לא נטו!).
     חשמל/מים/גז → כולל מעמ (לא לפני!).
     בנק        → יתרה סופית (לא תנועה בודדת!).
     פנסיה      → יתרה נצברת (לא הפקדה חודשית!).
     רפואי ללא חיוב → null.

4. amount_candidates: רשום את **כל** הסכומים המספריים שמצאת לסה\"כ/סיכום במסמך.
   amount_labels: תיאור מקביל ("ברוטו", "נטו", "לפני מעמ", "כולל מעמ", "יתרה", "הפקדה", וכו').
   הרשימות חייבות להיות באותו אורך ובאותו סדר.

5. category — חובה לבחור אחת **בדיוק** מהרשימה: {', '.join(CATEGORIES)}.
   מיפוי מהיר מ-doc_type לקטגוריה:
     תלוש_שכר → "תלוש שכר"
     חשבון_חשמל → "חשמל" | חשבון_מים → "מים" | חשבון_גז → "גז"
     חשבונית_מס/קבלה → "מוצרים"
     ביטוח_* → "ביטוח"
     רישיון_רכב/טסט_רכב/קבלת_מוסך/קנס_תנועה → "רכב"
     חוזה_שכירות/חוזה_קניית_דירה/ארנונה/נסח_טאבו → "דירה"
     דף_חשבון_בנק/הלוואה_*/משכנתא → "בנק"
     פירוט_כרטיס_אשראי → "אשראי"
     קרן_פנסיה/קרן_השתלמות/ביטוח_מנהלים/קופת_גמל → "פנסיה"
     שומת_מס/החזר_מס/מעמ_תקופתי/דוח_שנתי_מס → "מיסים"
     ביטל_* (ביטוח לאומי) → "אישורים"
     סיכום_רפואי/מרשם/תוצאות_*/חשבון_קופת_חולים → "רפואי"
     חשבון_סלולר/חשבון_אינטרנט/חשבון_כבלים_לוין → "תקשורת"
     אישור_לימודים/תעודת_בגרות/שכר_לימוד/מלגה → "חינוך"
     פסק_דין/כתב_תביעה/הסכם_*/חוזה_כללי → "משפטי"
     תעודת_זהות/דרכון/תעודת_לידה/צוואה → "מסמכים אישיים"
     אחר/לא ברור → "אחר"

6. name — תיאורי וייחודי. **חובה לכלול חודש ושנה** מ-purchase_date אם יש תאריך.
   אם אין תאריך — כלול תקופת חיוב או מספר חשבונית.

7. אם המסמך באנגלית: name ו-summary יכולים להיות באנגלית.

══ פורמט פלט סופי (JSON בלבד) ══

{{
  "name": "string",
  "category": "{ '|'.join(CATEGORIES) }",
  "sub_category": "string or null",
  "document_type": "string or null",
  "merchant": "string or null",
  "person": "string or null (שם הנפש מהרשימה אם המסמך אישי/רפואי)",
  "purchase_date": "YYYY-MM-DD or null",
  "warranty_end": "YYYY-MM-DD or null",
  "amount": number_or_null,
  "amount_candidates": [number, ...],
  "amount_labels": ["תיאור1", "תיאור2", ...],
  "document_period": {{ "from": "YYYY-MM-DD or null", "to": "YYYY-MM-DD or null" }},
  "summary": "string"
}}
"""


def _empty_extraction() -> dict[str, Any]:
    return {
        "name": None,
        "category": None,
        "sub_category": None,
        "document_type": None,
        "merchant": None,
        "person": None,
        "purchase_date": None,
        "warranty_end": None,
        "amount": None,
        "amount_candidates": [],
        "amount_labels": [],
        "document_period": None,
        "summary": None,
    }


def _normalize_period(value: Any) -> dict[str, str | None] | None:
    """Coerce document_period to {from, to} with YYYY-MM-DD strings or None."""
    if not isinstance(value, dict):
        return None
    f = normalize_date(value.get("from"))
    t = normalize_date(value.get("to"))
    if f is None and t is None:
        return None
    return {"from": f, "to": t}


def extract(
    image_urls: list[str],
    doc_type_detected: str | None,
    categories: list[str] | None = None,
    people: list[dict] | None = None,
    account_type: str = "personal",
    subcategories_map: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Run the Extractor vision call. Always returns a full skeleton dict
    with normalized amounts, dates, and category clamped to CATEGORIES.

    `categories` may be passed at call-time (e.g. from the user's current
    branch list) so newly-added user branches are recognized by the model
    without changing the prompt manually. If omitted, the built-in CATEGORIES
    list is used.
    `people` is a list of {name, id_number} dicts. When provided, the model
    is instructed to identify the person the document belongs to (by name OR
    by ID number) and return it in the `person` field.
    `account_type` is 'personal' or 'business' — affects category suggestions.
    `subcategories_map` is {category_name: [sub-branch names...]}. When given,
    the model is told to PREFER one of the listed sub-branches when classifying
    sub_category, including ones the user added recently."""
    # Build the effective category list: built-ins + account-specific + user-added.
    effective_categories = list(CATEGORIES)

    # Add business-only categories if account_type is business
    if account_type == "business":
        business_cats = ["עובדים", "לקוחות", "ספקים", "רישיונות"]
        for bc in business_cats:
            if bc not in effective_categories:
                effective_categories.append(bc)

    if categories:
        for c in categories:
            if c and c not in effective_categories:
                effective_categories.append(c)

    prompt = EXTRACTOR_PROMPT_TEMPLATE
    # Prepend the dynamic branch list and add Rule #6 about dynamic branches.
    dynamic_header = (
        f"ענפים נוכחיים במערכת: {' | '.join(effective_categories)}\n"
        "כלל #6 (ענפים דינמיים): הרשימה הנוכחית מועברת בתחילת הבקשה. "
        "בדוק תמיד אם המסמך שייך לאחד מהם, כולל ענפים חדשים שהמשתמש הוסיף "
        "לאחרונה. אל תניח שהרשימה קבועה. אם אין ענף מתאים — החזר \"אחר\".\n\n"
    )

    # If people are provided, append people block + rule #7 (person attribution).
    if people:
        people_lines = []
        for p in people:
            name = (p.get("name") or "").strip()
            id_num = (p.get("id_number") or "").strip()
            if not name:
                continue
            if id_num:
                people_lines.append(f"- {name} (ת.ז. {id_num})")
            else:
                people_lines.append(f"- {name}")
        if people_lines:
            people_block = (
                "נפשות במערכת (משפחה/לקוחות):\n"
                + "\n".join(people_lines)
                + "\n\n"
                "כלל #7 (זיהוי נפש): אם המסמך הוא אישי/רפואי, נסה לזהות "
                "למי מהנפשות הוא שייך, **גם לפי שם המופיע במסמך וגם לפי "
                "מספר תעודת זהות (ת.ז. / מס' זהות / ת.ז.)**. "
                "החזר את שם הנפש המדויק כפי שמופיע ברשימה למעלה בשדה `person`. "
                "אם לא ניתן לזהות בוודאות — החזר null.\n\n"
            )
            dynamic_header = dynamic_header + people_block

    # If sub-branches are provided, list them per-category so the AI can pick
    # one of the user's existing sub-branches instead of inventing a new name.
    if subcategories_map:
        sub_lines = []
        for cat_name, subs in subcategories_map.items():
            if not cat_name or not isinstance(subs, list):
                continue
            cleaned = [s for s in subs if isinstance(s, str) and s.strip() and s != "+"]
            if not cleaned:
                continue
            sub_lines.append(f"- {cat_name}: {' | '.join(cleaned)}")
        if sub_lines:
            sub_block = (
                "תתי-ענפים נוכחיים לכל קטגוריה (כולל תתי-ענפים שהמשתמש הוסיף לאחרונה):\n"
                + "\n".join(sub_lines)
                + "\n\n"
                "כלל #8 (תתי-ענפים): בעת מילוי שדה sub_category, **העדף בחזקה** "
                "אחד מתתי-הענפים הרשומים למעלה תחת הקטגוריה שבחרת. אם אף אחד "
                "לא מתאים בדיוק — בחר את הקרוב ביותר מבחינה סמנטית. רק אם אין "
                "התאמה סבירה כלל — החזר תת-ענף חדש או null. אל תמציא וריאציות "
                "של אותו שם (לדוגמה: אם קיים 'חוזה שכירות' — אל תחזיר 'חוזה' או "
                "'חוזה דירה' אלא 'חוזה שכירות' המדויק).\n\n"
            )
            dynamic_header = dynamic_header + sub_block

    prompt = dynamic_header + prompt
    if doc_type_detected:
        prompt += f"\n\ndoc_type_detected: {doc_type_detected}\n"

    try:
        raw = groq_vision.call_vision(
            prompt,
            image_urls,
            max_tokens=2048,
            stage="extractor",
        )
    except Exception as e:
        skel = _empty_extraction()
        skel["summary"] = f"Extraction failed: {e}"
        return skel

    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        skel = _empty_extraction()
        skel["summary"] = "Extraction failed: invalid JSON"
        return skel

    out = _empty_extraction()
    out.update({k: v for k, v in data.items() if v is not None})

    # ---- normalization layer (Post-Processing) ----
    out["amount"]            = normalize_amount(out.get("amount"))
    out["amount_candidates"] = normalize_amount_list(out.get("amount_candidates"))
    labels = out.get("amount_labels")
    out["amount_labels"] = (
        [str(x) for x in labels] if isinstance(labels, list) else []
    )
    out["purchase_date"]   = normalize_date(out.get("purchase_date"))
    out["warranty_end"]    = normalize_date(out.get("warranty_end"))
    out["document_period"] = _normalize_period(out.get("document_period"))
    out["category"]        = clamp_enum(out.get("category"), effective_categories, default="אחר")

    # Keep amount_labels aligned with amount_candidates length.
    if len(out["amount_labels"]) != len(out["amount_candidates"]):
        out["amount_labels"] = out["amount_labels"][: len(out["amount_candidates"])]
        while len(out["amount_labels"]) < len(out["amount_candidates"]):
            out["amount_labels"].append("")

    return out
