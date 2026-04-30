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


# Vision-capable model on Groq. Swap if Groq deprecates this one.
MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

# Max PDF pages we send per analysis (multi-page invoices etc.)
MAX_PAGES = 5

# Render PDF pages at this DPI. Higher = clearer Hebrew text but more tokens.
PDF_RENDER_DPI = 150

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

▸ purchase_date — חשוב מאוד, חלץ אותו תמיד אם קיים תאריך כלשהו במסמך:
  • חפש בסדר עדיפויות: "תאריך הנפקה", "תאריך החשבונית", "תאריך עסקה", "תאריך החיוב", "תאריך", "Date"
  • לפעמים זה מופיע ליד מספר החשבונית/הקבלה למעלה
  • אם רואה תאריך בפורמט DD/MM/YYYY או DD.MM.YYYY או DD-MM-YY — המר ל-YYYY-MM-DD
  • דוגמה: "12/03/2025" → "2025-03-12", "9.7.25" → "2025-07-09"
  • בחשבון שירות (חשמל/מים/גז) — אם אין תאריך הנפקה ברור, השתמש בתאריך סיום תקופת החיוב
  • אסור להחזיר null אם יש תאריך כלשהו במסמך — חלץ אותו!

▸ amount — חייב להיות הסכום הסופי לתשלום, כולל מע"מ:
  • חפש בסדר עדיפויות: "סה\"כ לתשלום", "סך הכל לתשלום", "סך הכל כולל מע\"מ", "יתרה לתשלום", "סך לתשלום", "Total"
  • זה תמיד הסכום הגדול והאחרון בטבלת הסיכום, לא סכום ביניים
  • אסור להחזיר את "סה\"כ לפני מע\"מ" או סכום של פריט בודד או סכום מע"מ עצמו
  • אם רואה כמה סכומים: "סכום ביניים: 850, מע\"מ: 144.50, סה\"כ לתשלום: 994.50" — תחזיר 994.50
  • החזר רק מספר עשרוני, ללא ש"ח / ₪ / NIS / פסיקים: 1037.28 (לא "1,037.28 ₪")

▸ warranty_end — רק אם זה מסמך אחריות עם תאריך תפוגה ברור. אחרת null.

▸ category — חובה לבחור מהרשימה למעלה. דוגמאות התאמה:
  • חשבון חשמל → "חשמל"
  • חשבון מים → "מים"  
  • חשבונית קנייה רגילה → "מוצרים"
  • פוליסת ביטוח רכב → "ביטוח" (sub_category: "רכב")
  • תלוש שכר → "תלוש שכר"

▸ name — תיאורי וייחודי. כלול את הסוחר/הסוג והתאריך כשאפשר.

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
        temperature=0.1,
        response_format={"type": "json_object"},
        max_tokens=1024,
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
