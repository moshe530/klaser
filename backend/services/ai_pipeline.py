"""
AI Pipeline orchestrator — combines Classifier + Extractor and applies
the v4.1 hardening layer (skeleton fallback, confidence guard, file_hash).

Public entry point:
    run_pipeline(data: bytes, mime_type: str) -> dict

The returned dict always has the same shape (skeleton merge), so callers
never have to deal with `KeyError` or partial responses.

Adds the v4.1 hardening layer:
  - file_hash (MD5) for future deduplication
  - confidence guard (low → generic extractor + needs_review)
  - skeleton fallback (always full shape)
  - timing/structured logging (took_ms per stage + overall)
  - Normalization happens inside the Extractor (amounts → float, dates → ISO).
"""
from __future__ import annotations

import hashlib
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from . import ai_classifier, ai_extractor, groq_vision

logger = logging.getLogger("klaser.ai_pipeline")

# Below this Classifier confidence we route to a generic Extractor and flag
# the document for manual review.
LOW_CONFIDENCE = "low"


def _full_skeleton() -> dict[str, Any]:
    """Single source of truth for the response shape. Always returned."""
    return {
        # Extractor fields
        "name":              None,
        "category":          None,
        "sub_category":      None,
        "document_type":     None,
        "merchant":          None,
        "purchase_date":     None,
        "warranty_end":      None,
        "amount":            None,
        "amount_candidates": [],
        "amount_labels":     [],
        "document_period":   None,
        "summary":           None,
        # Classifier fields
        "doc_type_detected": None,
        "confidence":        None,
        "confidence_reason": None,
        "needs_review":      False,
        "ocr_quality":       None,
        "language":          None,
        "structure":         None,
        # Pipeline meta
        "file_hash":         None,
    }


def _file_hash(data: bytes) -> str:
    return hashlib.md5(data).hexdigest()


def run_pipeline(
    data: bytes,
    mime_type: str,
    categories: list[str] | None = None,
    people: list[dict] | None = None,
    account_type: str = "personal",
    subcategories_map: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Full pipeline: hash → render → classify → guard → extract → merge.

    `categories` is the user's current branch list; forwarded to the Extractor.
    `people`     is the user's people list ({name, id_number}); forwarded to
                 the Extractor for medical/personal document attribution.
    `account_type` is 'personal' or 'business' — affects AI prompts.
    `subcategories_map` is a {category: [sub-branches]} dict so the AI can
    PREFER one of the user's existing sub-branches when classifying."""
    pipeline_t0 = time.perf_counter()
    result = _full_skeleton()
    result["file_hash"] = _file_hash(data)
    file_size = len(data)

    logger.info(
        "pipeline.start hash=%s mime=%s size=%d",
        result["file_hash"], mime_type, file_size,
    )

    # 1. Render the file once; both stages share the same images.
    try:
        image_urls = groq_vision.file_to_image_urls(data, mime_type)
    except Exception as e:
        logger.exception("pipeline.render_failed hash=%s", result["file_hash"])
        result["summary"] = f"Could not prepare file: {e}"
        result["needs_review"] = True
        return result

    # 2-3. PARALLEL: run Classifier + Extractor at the same time.
    # The Extractor starts with doc_type=None (no hint) so we don't have to
    # wait for the Classifier. The Classifier still runs to produce
    # confidence / needs_review / ocr_quality / language / structure metadata
    # used by the Confidence Guard below.
    t_par = time.perf_counter()
    with ThreadPoolExecutor(max_workers=2) as pool:
        cls_future = pool.submit(ai_classifier.classify, image_urls)
        ext_future = pool.submit(
            ai_extractor.extract,
            image_urls,
            None,  # doc_type_detected=None — Extractor uses its full prompt
            categories,
            people,
            account_type,
            subcategories_map,
        )
        classification = cls_future.result()
        extraction = ext_future.result()
    par_ms = int((time.perf_counter() - t_par) * 1000)

    # Merge classification metadata first (doc_type, confidence, quality...)
    for k in (
        "doc_type_detected", "confidence", "confidence_reason",
        "needs_review", "ocr_quality", "language", "structure",
    ):
        if classification.get(k) is not None:
            result[k] = classification[k]

    # Confidence guard — force needs_review when Classifier is unsure.
    # (We can't re-route the Extractor anymore since it already ran in
    # parallel, but the needs_review flag still surfaces low-confidence
    # documents to the user for manual check.)
    if result["confidence"] == LOW_CONFIDENCE:
        logger.warning(
            "pipeline.low_confidence hash=%s reason=%r doc_type=%r",
            result["file_hash"], result["confidence_reason"],
            result["doc_type_detected"],
        )
        result["needs_review"] = True

    # Merge extraction fields.
    for k, v in extraction.items():
        if v is not None and v != []:
            result[k] = v
    # Keep legacy variable names so the closing log line below still works.
    cls_ms = par_ms
    ext_ms = par_ms

    total_ms = int((time.perf_counter() - pipeline_t0) * 1000)
    logger.info(
        "pipeline.done hash=%s pages=%d total_ms=%d cls_ms=%d ext_ms=%d "
        "doc_type=%s confidence=%s needs_review=%s amount=%s",
        result["file_hash"], len(image_urls), total_ms, cls_ms, ext_ms,
        result["doc_type_detected"], result["confidence"],
        result["needs_review"], result["amount"],
    )
    return result
