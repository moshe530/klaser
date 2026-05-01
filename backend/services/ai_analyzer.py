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


def analyze_file(data: bytes, mime_type: str) -> dict[str, Any]:
    """Run the full AI pipeline on a file. Returns the v4.1 unified shape."""
    return ai_pipeline.run_pipeline(data, mime_type)
