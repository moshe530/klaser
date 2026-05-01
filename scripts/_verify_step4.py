"""Quick sanity check for AI pipeline v4.1 step 4 (normalize + imports).
Run: .venv\\Scripts\\python.exe scripts\\_verify_step4.py
Should finish in under a second. No external calls — only pure-Python checks.
"""
import sys
from pathlib import Path

# Make `backend` importable when run as a plain script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.services.normalize import (
    normalize_amount,
    normalize_amount_list,
    normalize_date,
    clamp_enum,
)

# --- normalize_amount ---
amount_cases = {
    "1,200 ₪":        1200.0,
    "1037.28":        1037.28,
    "1,037.28 ₪":     1037.28,
    "₪ 12,345.67":    12345.67,
    'ש"ח 1234':       1234.0,
    "-500":           -500.0,
    "":               None,
    None:             None,
    "abc":            None,
    1234:             1234.0,
    1.5:              1.5,
}
for k, want in amount_cases.items():
    got = normalize_amount(k)
    assert got == want, f"amount({k!r}) -> {got} expected {want}"

# --- normalize_amount_list ---
assert normalize_amount_list(["1,200", 1500, "abc", None]) == [1200.0, 1500.0]
assert normalize_amount_list(None) == []
assert normalize_amount_list("not a list") == []

# --- normalize_date ---
date_cases = {
    "2025-03-12":  "2025-03-12",
    "12/03/2025":  "2025-03-12",
    "12-3-2025":   "2025-03-12",
    "12.3.2025":   "2025-03-12",
    "9.7.25":      "2025-07-09",
    "2025/3/12":   "2025-03-12",
    "":            None,
    "tomorrow":    None,
    "32/13/2025":  None,
}
for k, want in date_cases.items():
    got = normalize_date(k)
    assert got == want, f"date({k!r}) -> {got} expected {want}"

# --- clamp_enum ---
assert clamp_enum("high", ("high", "medium", "low"), default="low") == "high"
assert clamp_enum("foo",  ("high", "medium", "low"), default="low") == "low"
assert clamp_enum(None,   ("high", "medium", "low"), default="low") == "low"

print("OK normalize")

# --- Import full pipeline (no network calls) ---
from backend.services import ai_pipeline, ai_classifier, ai_extractor, ai_analyzer, groq_vision  # noqa: F401
from backend.main import app  # noqa: F401

print(f"OK pipeline imports, DOC_TYPES count: {len(ai_classifier.DOC_TYPES)}")
print("All step-4 sanity checks passed.")
