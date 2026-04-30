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

PROMPT = f"""אתה עוזר לסיווג ולחילוץ מידע ממסמכים בעברית.
המסמך יכול להיות חשבונית, חוזה, אחריות, קבלה, חשבון שירות (חשמל/מים/גז), תלוש שכר, מסמך רפואי, מסמך זיהוי וכו'.

החזר אובייקט JSON תקין יחיד (בלי טקסט נוסף לפני או אחרי) עם השדות הבאים בדיוק:

{{
  "name": "שם תיאורי קצר וברור למסמך, למשל: חשבון חשמל ינואר 2025",
  "category": "אחת מהקטגוריות: {', '.join(CATEGORIES)}",
  "sub_category": "תת-קטגוריה או null",
  "document_type": "סוג המסמך — חשבונית, אחריות, חוזה וכו', או null",
  "merchant": "שם הספק/חברה או null",
  "purchase_date": "YYYY-MM-DD או null",
  "warranty_end": "YYYY-MM-DD או null",
  "amount": "מספר עשרוני ללא סימן מטבע, או null",
  "summary": "משפט אחד קצר בעברית שמתאר את המסמך"
}}

הוראות חשובות:
- אם שדה לא קיים או לא ניתן לחלץ בוודאות — החזר null (לא מחרוזת ריקה).
- תאריכים אך ורק בפורמט YYYY-MM-DD.
- amount — מספר בלבד. אם יש כמה תשלומים, החזר את הסכום הכולל.
- החזר אך ורק את ה-JSON, בלי הסבר וללא עטיפת ```.
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
