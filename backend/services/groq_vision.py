"""
Shared low-level Groq Vision plumbing used by ai_classifier + ai_extractor.

  - Lazy import of `groq` and `fitz` (PyMuPDF) so server boots even if not installed.
  - PDF -> list[PNG bytes] rendering at a high enough DPI to read Hebrew receipts.
  - Vision call helper that takes a prompt + a list of image data-URLs and
    returns the raw model text.
"""
from __future__ import annotations

import base64
import logging
import time
from typing import Any

from ..config import settings

logger = logging.getLogger("klaser.groq_vision")

# Vision-capable model on Groq free tier.
MODEL = "meta-llama/llama-4-scout-17b-16e-instruct"

# Cap pages per request to keep latency + token cost bounded.
MAX_PAGES = 5

# DPI for PDF rendering. 200 DPI gives ~1700x2400 px — readable for small line-items.
PDF_RENDER_DPI = 200


# ---------------------------------------------------------------------------
# Lazy imports + client
# ---------------------------------------------------------------------------
_groq_mod = None
_fitz_mod = None
_client = None


def _lazy_imports():
    global _groq_mod, _fitz_mod
    if _groq_mod is None:
        try:
            import groq as _g
            import fitz as _f  # PyMuPDF
        except ImportError as e:
            raise RuntimeError(
                "Required packages not installed. Run: pip install -r requirements.txt"
            ) from e
        _groq_mod, _fitz_mod = _g, _f
    return _groq_mod, _fitz_mod


# Per-request timeout (seconds). The Groq SDK accepts this directly.
REQUEST_TIMEOUT = 60.0

# Retry config for transient failures (network blips, 5xx, rate-limit).
MAX_RETRIES = 2          # → up to 3 attempts in total
RETRY_BACKOFF_SEC = 1.5  # multiplied by attempt index


def get_client():
    global _client
    if _client is None:
        groq, _ = _lazy_imports()
        if not settings.GROQ_API_KEY:
            raise RuntimeError("GROQ_API_KEY is missing in .env")
        _client = groq.Groq(
            api_key=settings.GROQ_API_KEY,
            timeout=REQUEST_TIMEOUT,
            max_retries=0,  # we own retry logic so we can log each attempt
        )
    return _client


# ---------------------------------------------------------------------------
# File -> image data URLs
# ---------------------------------------------------------------------------
def pdf_to_png_pages(pdf_bytes: bytes, max_pages: int = MAX_PAGES) -> list[bytes]:
    _, fitz = _lazy_imports()
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


def to_data_url(img_bytes: bytes, mime: str = "image/png") -> str:
    b64 = base64.b64encode(img_bytes).decode("ascii")
    return f"data:{mime};base64,{b64}"


def file_to_image_urls(data: bytes, mime_type: str) -> list[str]:
    """Convert any supported input file into a list of vision-ready data URLs."""
    if mime_type == "application/pdf":
        return [to_data_url(p, "image/png") for p in pdf_to_png_pages(data)]
    if mime_type.startswith("image/"):
        return [to_data_url(data, mime_type)]
    raise RuntimeError(f"Unsupported mime type for analysis: {mime_type}")


# ---------------------------------------------------------------------------
# Vision call
# ---------------------------------------------------------------------------
def call_vision(
    prompt: str,
    image_urls: list[str],
    *,
    max_tokens: int = 2048,
    temperature: float = 0.0,
    stage: str = "vision",
) -> str:
    """Send prompt + images to Groq and return raw model text (JSON expected).

    Adds a small retry loop with exponential backoff. ``stage`` is used in
    log messages (e.g. ``"classifier"`` / ``"extractor"``) so multi-call
    pipelines are easy to debug.
    """
    client = get_client()

    user_content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    for url in image_urls:
        user_content.append({"type": "image_url", "image_url": {"url": url}})

    last_err: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        t0 = time.perf_counter()
        try:
            response = client.chat.completions.create(
                model=MODEL,
                messages=[{"role": "user", "content": user_content}],
                temperature=temperature,
                response_format={"type": "json_object"},
                max_tokens=max_tokens,
            )
            took_ms = int((time.perf_counter() - t0) * 1000)

            text = (response.choices[0].message.content or "").strip()
            if not text:
                raise RuntimeError("Empty response from Groq")

            # Strip code fences if the model adds them despite instructions
            if text.startswith("```"):
                text = text.strip("`")
                if text.lower().startswith("json"):
                    text = text[4:].strip()

            logger.info(
                "groq.%s ok attempt=%d took_ms=%d pages=%d chars=%d",
                stage, attempt + 1, took_ms, len(image_urls), len(text),
            )
            return text

        except Exception as e:  # network / 5xx / 429 / sdk errors
            took_ms = int((time.perf_counter() - t0) * 1000)
            last_err = e
            logger.warning(
                "groq.%s fail attempt=%d took_ms=%d err=%s: %s",
                stage, attempt + 1, took_ms, type(e).__name__, e,
            )
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SEC * (attempt + 1))

    # All attempts exhausted
    assert last_err is not None
    raise RuntimeError(f"groq.{stage} failed after {MAX_RETRIES + 1} attempts: {last_err}") from last_err
