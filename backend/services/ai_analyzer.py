"""
Backward-compat shim.

The original single-call analyzer was split in v4.1 into:
    groq_vision  + ai_classifier + ai_extractor + ai_pipeline

This module re-exports `analyze_file` as a thin wrapper so existing callers
(routes/documents.py, tests, scripts) keep working unchanged.
"""
from __future__ import annotations

from typing import Any

from . import ai_pipeline


def analyze_file(
    data: bytes,
    mime_type: str,
    categories: list[str] | None = None,
    people: list[dict] | None = None,
) -> dict[str, Any]:
    """Run the full AI pipeline on a file. Returns the v4.1 unified shape.

    `categories` (optional) is the user's current branch list, forwarded to
    the extractor so newly-added user branches are recognized.
    `people` (optional) is a list of {name, id_number} so the extractor can
    associate medical/personal documents with the right family member."""
    return ai_pipeline.run_pipeline(
        data,
        mime_type,
        categories=categories,
        people=people,
    )
