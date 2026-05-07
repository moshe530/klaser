from uuid import UUID

from fastapi import APIRouter, Body, File, HTTPException, Query, Request, UploadFile

from ..auth import AuthContext, AuthDep
from ..limiter import limiter
from ..models import DocumentCreate, DocumentOut, DocumentUpdate
from ..services import ai_analyzer, storage

router = APIRouter(prefix="/documents", tags=["documents"])

TABLE = "documents"

MAX_FILE_BYTES = 10 * 1024 * 1024  # 10 MB
ALLOWED_MIME = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
    "image/heic",
}

# Magic-byte signatures for the formats we accept. Validating these prevents
# clients from disguising arbitrary content as a valid Content-Type.
# Each entry is a list of (offset, byte-prefix) tuples — ALL must match.
_MAGIC_BYTES: dict[str, list[tuple[int, bytes]]] = {
    "application/pdf":  [(0, b"%PDF-")],
    "image/png":        [(0, b"\x89PNG\r\n\x1a\n")],
    "image/jpeg":       [(0, b"\xff\xd8\xff")],
    # WebP: "RIFF????WEBP"
    "image/webp":       [(0, b"RIFF"), (8, b"WEBP")],
    # HEIC/HEIF: starts with "????ftyp" followed by a brand like "heic","heix","mif1","msf1","heif"
    "image/heic":       [(4, b"ftyp")],
}


def _validate_magic_bytes(data: bytes, content_type: str) -> bool:
    """Verify file content matches its declared MIME type via magic bytes."""
    sigs = _MAGIC_BYTES.get(content_type)
    if not sigs:
        return False
    for offset, prefix in sigs:
        if not data[offset:offset + len(prefix)] == prefix:
            return False
    return True


def _get_owned_doc(auth: AuthContext, doc_id: UUID) -> dict:
    res = (
        auth.client.table(TABLE)
        .select("*")
        .eq("id", str(doc_id))
        .eq("user_id", str(auth.user_id))
        .single()
        .execute()
    )
    if not res.data:
        raise HTTPException(404, "Document not found")
    return res.data


@router.get("", response_model=list[DocumentOut])
def list_documents(
    auth: AuthContext = AuthDep,
    category: str | None = Query(default=None),
    limit: int = Query(default=100, le=500),
    offset: int = Query(default=0, ge=0),
):
    q = (
        auth.client.table(TABLE)
        .select("*")
        .eq("user_id", str(auth.user_id))
        .order("created_at", desc=True)
        .range(offset, offset + limit - 1)
    )
    if category:
        q = q.eq("category", category)
    res = q.execute()
    return res.data or []


@router.post("", response_model=DocumentOut, status_code=201)
def create_document(payload: DocumentCreate, auth: AuthContext = AuthDep):
    row = payload.model_dump(mode="json", exclude_none=True)
    row["user_id"] = str(auth.user_id)
    res = auth.client.table(TABLE).insert(row).execute()
    if not res.data:
        raise HTTPException(500, "Insert failed")
    return res.data[0]


@router.get("/{doc_id}", response_model=DocumentOut)
def get_document(doc_id: UUID, auth: AuthContext = AuthDep):
    res = (
        auth.client.table(TABLE)
        .select("*")
        .eq("id", str(doc_id))
        .eq("user_id", str(auth.user_id))
        .single()
        .execute()
    )
    if not res.data:
        raise HTTPException(404, "Document not found")
    return res.data


@router.patch("/{doc_id}", response_model=DocumentOut)
def update_document(doc_id: UUID, payload: DocumentUpdate, auth: AuthContext = AuthDep):
    patch = payload.model_dump(mode="json", exclude_none=True)
    if not patch:
        raise HTTPException(400, "No fields to update")
    res = (
        auth.client.table(TABLE)
        .update(patch)
        .eq("id", str(doc_id))
        .eq("user_id", str(auth.user_id))
        .execute()
    )
    if not res.data:
        raise HTTPException(404, "Document not found")
    return res.data[0]


@router.delete("/{doc_id}", status_code=204)
def delete_document(doc_id: UUID, auth: AuthContext = AuthDep):
    # Best-effort: also remove the file from storage
    res = (
        auth.client.table(TABLE)
        .select("file_path")
        .eq("id", str(doc_id))
        .eq("user_id", str(auth.user_id))
        .maybe_single()
        .execute()
    )
    if res and res.data and res.data.get("file_path"):
        storage.remove(auth.client, res.data["file_path"])

    auth.client.table(TABLE).delete().eq("id", str(doc_id)).eq(
        "user_id", str(auth.user_id)
    ).execute()
    return None


# ============================================================
# FILE ATTACHMENTS
# ============================================================
@router.post("/{doc_id}/file", response_model=DocumentOut)
@limiter.limit("30/minute")
async def upload_file(
    request: Request,
    doc_id: UUID,
    file: UploadFile = File(...),
    auth: AuthContext = AuthDep,
):
    doc = _get_owned_doc(auth, doc_id)

    # Read & validate
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(400, "Empty file")
    if len(data) > MAX_FILE_BYTES:
        raise HTTPException(413, f"File too large (max {MAX_FILE_BYTES // 1024 // 1024} MB)")

    content_type = file.content_type or "application/octet-stream"
    if content_type not in ALLOWED_MIME:
        raise HTTPException(415, f"Unsupported mime type: {content_type}")

    # Verify file content matches its declared MIME type via magic bytes.
    # Prevents clients disguising arbitrary executables/scripts as PDFs/images.
    if not _validate_magic_bytes(data, content_type):
        raise HTTPException(
            400,
            f"File content does not match declared type {content_type} "
            "(magic-byte mismatch)",
        )

    # If there was a previous file — remove it
    if doc.get("file_path"):
        storage.remove(auth.client, doc["file_path"])

    path = storage.object_path(auth.user_id, doc_id, file.filename or "file")
    try:
        storage.upload_bytes(auth.client, path, data, content_type)
    except Exception as e:
        raise HTTPException(500, f"Storage upload failed: {e}")

    res = (
        auth.client.table(TABLE)
        .update({
            "file_path": path,
            "file_size": len(data),
            "mime_type": content_type,
            "ocr_status": "pending",
        })
        .eq("id", str(doc_id))
        .eq("user_id", str(auth.user_id))
        .execute()
    )
    if not res.data:
        raise HTTPException(500, "Failed to update document record")
    return res.data[0]


@router.get("/{doc_id}/file-url")
def get_file_url(doc_id: UUID, auth: AuthContext = AuthDep):
    """Return a short-lived signed URL for downloading/viewing the file."""
    doc = _get_owned_doc(auth, doc_id)
    if not doc.get("file_path"):
        raise HTTPException(404, "No file attached to this document")
    url = storage.signed_url(auth.client, doc["file_path"], expires_in=600)
    if not url:
        raise HTTPException(500, "Failed to generate signed URL")
    return {"url": url, "expires_in": 600}


# ============================================================
# AI ANALYSIS (Groq vision pipeline v4.1)
# ============================================================
# Rate-limited because each call hits Groq's vision API and costs money.
# 20 analyses/minute per IP is generous for legitimate use, blocks abuse loops.
@router.post("/{doc_id}/analyze", response_model=DocumentOut)
@limiter.limit("20/minute")
def analyze_document(
    request: Request,
    doc_id: UUID,
    auth: AuthContext = AuthDep,
    payload: dict | None = Body(default=None),
):
    """Run the Groq vision pipeline (Classifier + Extractor) on the attached
    file and update document fields. User-edited fields are preserved on
    re-analysis; pipeline metadata is always overwritten.

    Optional request body: {"categories": ["ענף1", "ענף2", ...]}
    These are merged with the built-in CATEGORIES so the AI recognizes
    user-added branches without redeploying the prompt."""
    doc = _get_owned_doc(auth, doc_id)
    if not doc.get("file_path"):
        raise HTTPException(400, "Document has no attached file to analyze")

    # Extract user categories, people, and account type from request body (optional)
    user_categories: list[str] | None = None
    user_people: list[dict] | None = None
    account_type: str = "personal"  # default to personal
    user_subcategories: dict[str, list[str]] | None = None
    if isinstance(payload, dict):
        cats = payload.get("categories")
        if isinstance(cats, list):
            user_categories = [str(c) for c in cats if c]
        people = payload.get("people")
        if isinstance(people, list):
            user_people = [p for p in people if isinstance(p, dict) and p.get("name")]
        # Account type: 'personal' or 'business' - affects AI prompts
        acct_type = payload.get("account_type")
        if acct_type in ("personal", "business"):
            account_type = acct_type
        # Sub-categories per category, so the AI prefers existing sub-branches
        subs = payload.get("subcategories")
        if isinstance(subs, dict):
            cleaned: dict[str, list[str]] = {}
            for k, v in subs.items():
                if not isinstance(k, str) or not isinstance(v, list):
                    continue
                vals = [str(s) for s in v if isinstance(s, str) and s.strip() and s != "+"]
                if vals:
                    cleaned[k] = vals
            user_subcategories = cleaned or None

    # Mark as processing
    auth.client.table(TABLE).update({"ocr_status": "processing"}).eq(
        "id", str(doc_id)
    ).eq("user_id", str(auth.user_id)).execute()

    try:
        data = storage.download_bytes(auth.client, doc["file_path"])
        result = ai_analyzer.analyze_file(
            data,
            doc.get("mime_type") or "application/pdf",
            categories=user_categories,
            people=user_people,
            account_type=account_type,
            subcategories_map=user_subcategories,
        )
    except Exception as e:
        import traceback
        traceback.print_exc()  # מדפיס את ה-stack trace המלא לטרמינל uvicorn
        auth.client.table(TABLE).update({"ocr_status": "failed"}).eq(
            "id", str(doc_id)
        ).eq("user_id", str(auth.user_id)).execute()
        raise HTTPException(500, f"AI analysis failed: {type(e).__name__}: {e}")

    # Build update — fill fields intelligently.
    # Two groups:
    #   (a) USER-EDITABLE extractor fields: respect existing user edits unless
    #       it's the first analysis or the value is a placeholder.
    #   (b) PIPELINE METADATA: always overwrite — these describe the AI's own
    #       understanding of the document and aren't edited by users.
    patch: dict = {
        "ai_data":    result,
        "ocr_status": "done",
    }

    # (a) User-editable extractor fields → fill-if-empty semantics
    field_map = {
        "name":            "name",
        "category":        "category",
        "sub_category":    "sub_category",
        "purchase_date":   "purchase_date",
        "warranty_end":    "warranty_end",
        "amount":          "amount",
        "document_type":   "document_type",
        "merchant":        "merchant",
        "document_period": "document_period",
    }

    # Frontend defaults that aren't real user input — treat as empty.
    PLACEHOLDER_NAMES = {
        "⏳ ממתין לניתוח AI",
        "ממתין לניתוח AI",
        "מסמך חדש",
        "",
    }

    # First-time analysis (no prior ai_data) → trust AI for fields that were
    # form defaults. On re-analysis, preserve user edits.
    is_first_analysis = not doc.get("ai_data")

    for ai_key, db_key in field_map.items():
        val = result.get(ai_key)
        if val in (None, "", []):
            continue
        existing = doc.get(db_key)
        is_placeholder_name = (
            db_key == "name"
            and isinstance(existing, str)
            and existing.strip() in PLACEHOLDER_NAMES
        )
        # On first analysis, also override category/dates/type that look like defaults
        first_run_override = is_first_analysis and db_key in {
            "category", "sub_category", "purchase_date", "warranty_end",
            "document_type", "merchant", "document_period",
        }
        if not existing or is_placeholder_name or first_run_override:
            patch[db_key] = val

    # (b) Pipeline metadata — always overwrite with the latest run.
    #     These describe this analysis run, not user data.
    for meta_key in (
        "doc_type_detected", "confidence", "confidence_reason", "needs_review",
        "ocr_quality", "language", "structure", "file_hash",
        "amount_candidates", "amount_labels",
    ):
        if meta_key in result:
            patch[meta_key] = result[meta_key]

    res = (
        auth.client.table(TABLE)
        .update(patch)
        .eq("id", str(doc_id))
        .eq("user_id", str(auth.user_id))
        .execute()
    )
    if not res.data:
        raise HTTPException(500, "Failed to update document with AI results")
    return res.data[0]
