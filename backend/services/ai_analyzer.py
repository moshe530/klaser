"""
AI document analyzer powered by Groq (Llama 4 Vision).

Why Groq:
  - Free tier: 30 RPM, no daily request cap on most models
  - Very fast inference (~1s per request)
  - Llama 4 vision models handle Hebrew well

PDFs are converted to PNG images via PyMuPDF (no system deps) since the
vision API only accepts images. We send up to MAX_PAGES images per request.
"""
from __future__ import annotations

import base64
import io
import json
from typing import Any

from ..config import settings

# Lazy imports — packages may not be installed yet. The server should still
# start; analyze endpoint will only fail when actually invoked.
_groq = None
_fitz = None


def _lazy_import():
    global _groq, _fitz
    if _groq is None:
        try:
            import groq as _g
            import fitz as _f  # PyMuPDF
        except ImportError as e:
            raise RuntimeError(
                "Required packages not installed. Run: pip install -r requirements.txt"
            ) from e
        _groq = _g
        _fitz = _f
    return _groq, _fitz


# Vision-capable model on Groq.
MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

# Max PDF pages we send per analysis (multi-page invoices etc.)
MAX_PAGES = 5

# Render PDF pages at this DPI. Higher = clearer Hebrew text & numbers.
# 200 DPI gives ~1700×2400 px page — readable for small invoice line-items.
PDF_RENDER_DPI = 200

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
    "אחר",
]

PROMPT = f"""אתה עוזר לסיווג ולחילוץ מידע ממסמכים בעברית (חשבוניות, חוזים, אחריות, קבלות, חשבונות שירות, תלושי שכר, מסמכים רפואיים וכו').

החזר אובייקט JSON תקין יחיד בלבד (בלי טקסט נוסף ובלי ```), עם השדות הבאים:

{{
  "name": "שם תיאורי קצר וברור — לדוגמה: 'חשבון חשמל ינואר 2025', 'אחריות מקרר Bosch', 'חשבונית סופרמרקט שופרסל 12.3.25'",
  "category": "חובה לבחור אחת בדיוק: {', '.join(CATEGORIES)}",
  "sub_category": "תת-קטגוריה או null",
  "document_type": "חשבונית / קבלה / אחריות / חוזה / תלוש / כתב שירות / וכו', או null",
  "merchant": "שם החברה/הספק/הסוחר המופיע במסמך, או null",
  "purchase_date": "YYYY-MM-DD",
  "warranty_end": "YYYY-MM-DD או null",
  "amount": "מספר עשרוני בלבד, או null",
  "summary": "משפט אחד קצר בעברית"
}}

═══ כללי חילוץ קריטיים ═══

▸▸▸ amount — קריטי! עקוב אחרי האלגוריתם הזה במדויק:

  שלב 1: זהה את כל השורות במסמך שמכילות "סה\"כ" או "סך הכל" או "Total" או "יתרה לתשלום".

  שלב 2: בחר את השורה שמכילה אחת מהמילים: "כולל מע\"מ", "לתשלום", "לתקופת החשבון",
  "מע\"מ כולל". זה הסכום הסופי. בחשבונית ישראלית טיפוסית הוא תמיד **השורה האחרונה**
  ב-טבלת הסיכום והמספר ה**גדול ביותר** מבין כל סכומי "סה\"כ".

  שלב 3: אם יש את שלושת השורות הבאות — אסור בהחלט לבחור את הראשונה!
    סה\"כ ללא מע\"מ:    574.48    ← אסור! זה לפני מע\"מ
    סה\"כ מע\"מ:        103.41    ← אסור! זה רק המע\"מ
    סה\"כ כולל מע\"מ:   677.89    ← זה הנכון! ✓

  שלב 4: בדיקה עצמית לפני שאתה עונה:
    • האם המספר שבחרתי הוא הגדול ביותר מבין כל ה-"סה\"כ" במסמך? אם לא — חזור לשלב 1.
    • האם השורה שבחרתי כוללת את המילה "כולל" או "לתשלום" או "לתקופת"? אם לא — חזור לשלב 1.

  שלב 5: פורמט: רק מספר עשרוני, ללא ₪/ש\"ח/פסיקים. דוגמה: 1037.28 (לא "1,037.28 ₪")

▸▸▸ purchase_date — חובה לחלץ אם יש תאריך כלשהו:

  סדר עדיפויות:
  1. "מועד התשלום" / "תאריך לתשלום" / "תאריך פירעון"
  2. "תאריך עריכת החשבון" / "תאריך הנפקה" / "תאריך החשבונית"
  3. "תאריך עסקה" / "תאריך"
  4. אם רק תקופה (למשל "01/02/2026 - 01/03/2026") — בחר את **תאריך הסיום** (01/03/2026)

  המרת פורמט (חובה!):
    "12/03/2025" → "2025-03-12"
    "9.7.25"     → "2025-07-09"
    "01/03/2026" → "2026-03-01"

  אסור להחזיר null אם יש כלשהו תאריך במסמך.

▸ warranty_end — רק אם זה מסמך אחריות עם תאריך תפוגה ברור. אחרת null.

▸ category — חובה לבחור מהרשימה למעלה. דוגמאות התאמה:
  • חשבון חשמל → "חשמל"
  • חשבון מים → "מים"  
  • חשבונית קנייה רגילה → "מוצרים"
  • פוליסת ביטוח רכב → "ביטוח" (sub_category: "רכב")
  • תלוש שכר → "תלוש שכר"

▸ name — תיאורי וייחודי. **חובה לכלול חודש ושנה** מ-purchase_date.
  פורמטים מועדפים:
    "חשבון חשמל סופרפאואר - מרץ 2026"
    "חשבונית שופרסל 12.3.25"
    "אחריות מקרר Bosch (תפוגה 2027)"
  אם אין תאריך — כלול תקופת חיוב או מספר חשבונית.

▸ אם שדה לא קיים בוודאות — null. לא מחרוזת ריקה ולא ניחוש.
"""


_client = None


def _get_client():
    global _client
    if _client is None:
        groq, _ = _lazy_import()
        if not settings.GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is missing in .env")
        _client = groq.Groq(api_key=settings.GROQ_API_KEY)
    return _client


def _pdf_to_png_pages(pdf_bytes: bytes, max_pages: int = MAX_PAGES) -> list[bytes]:
    """Convert a PDF to a list of PNG byte-arrays (one per page)."""
    _, fitz = _lazy_import()
    pages: list[bytes] = []
    with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
        for i, page in enumerate(doc):
            if i >= max_pages:
                break
            pix = page.get_pixmap(dpi=PDF_RENDER_DPI)
            pages.append(pix.tobytes("png"))
    if not pages:
        raise RuntimeError("PDF has no pages or could not be rendered")
    return pages


def _to_data_url(img_bytes: bytes, mime: str = "image/png") -> str:
    b64 = base64.b64encode(img_bytes).decode("ascii")
    return f"data:{mime};base64,{b64}"


def analyze_file(data: bytes, mime_type: str) -> dict[str, Any]:
    """Send file bytes to Groq vision model and return parsed structured fields.

    Accepts PDF (auto-converted to images) or any common image format.
    """
    client = _get_client()

    # Build list of image data URLs
    if mime_type == "application/pdf":
        page_pngs = _pdf_to_png_pages(data)
        image_urls = [_to_data_url(p, "image/png") for p in page_pngs]
    elif mime_type.startswith("image/"):
        image_urls = [_to_data_url(data, mime_type)]
    else:
        raise RuntimeError(f"Unsupported mime type for analysis: {mime_type}")

    user_content: list[dict] = [{"type": "text", "text": PROMPT}]
    for url in image_urls:
        user_content.append({"type": "image_url", "image_url": {"url": url}})

    response = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": user_content}],
        temperature=0,
        response_format={"type": "json_object"},
        max_tokens=2048,
    )

    text = (response.choices[0].message.content or "").strip()
    if not text:
        raise RuntimeError("Empty response from Groq")

    # Strip code fences if model added them despite instructions
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:].strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Groq returned invalid JSON: {e}\nRaw: {text[:400]}")
