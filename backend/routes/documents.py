from uuid import UUID

from fastapi import APIRouter, File, HTTPException, Query, UploadFile

from ..auth import AuthContext, AuthDep
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
async def upload_file(
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
# AI ANALYSIS (Gemini)
# ============================================================
@router.post("/{doc_id}/analyze", response_model=DocumentOut)
def analyze_document(doc_id: UUID, auth: AuthContext = AuthDep):
    """Run Gemini on the attached file and update document fields.
    Only fills fields that are currently empty (won't overwrite user input)."""
    doc = _get_owned_doc(auth, doc_id)
    if not doc.get("file_path"):
        raise HTTPException(400, "Document has no attached file to analyze")

    # Mark as processing
    auth.client.table(TABLE).update({"ocr_status": "processing"}).eq(
        "id", str(doc_id)
    ).eq("user_id", str(auth.user_id)).execute()

    try:
        data = storage.download_bytes(auth.client, doc["file_path"])
        result = ai_analyzer.analyze_file(data, doc.get("mime_type") or "application/pdf")
    except Exception as e:
        import traceback
        traceback.print_exc()  # מדפיס את ה-stack trace המלא לטרמינל uvicorn
        auth.client.table(TABLE).update({"ocr_status": "failed"}).eq(
            "id", str(doc_id)
        ).eq("user_id", str(auth.user_id)).execute()
        raise HTTPException(500, f"AI analysis failed: {type(e).__name__}: {e}")

    # Build update — fill fields intelligently
    patch: dict = {
        "ai_data": result,
        "ocr_status": "done",
    }
    field_map = {
        "name":          "name",
        "category":      "category",
        "sub_category":  "sub_category",
        "purchase_date": "purchase_date",
        "warranty_end":  "warranty_end",
        "amount":        "amount",
    }

    # Frontend defaults that aren't real user input — treat as empty.
    # Match both with and without the hourglass emoji prefix.
    PLACEHOLDER_NAMES = {
        "⏳ ממתין לניתוח AI",
        "ממתין לניתוח AI",
        "מסמך חדש",
        "",
    }

    # First-time analysis (no prior ai_data) → trust AI for everything that
    # might have been a form default. On re-analysis, keep user's edits.
    is_first_analysis = not doc.get("ai_data")

    for ai_key, db_key in field_map.items():
        val = result.get(ai_key)
        if val in (None, "", []):
            continue
        existing = doc.get(db_key)
        is_placeholder_name = db_key == "name" and existing in PLACEHOLDER_NAMES
        # On first analysis, also override category/dates that look like defaults
        first_run_override = is_first_analysis and db_key in {
            "category", "sub_category", "purchase_date", "warranty_end"
        }
        if not existing or is_placeholder_name or first_run_override:
            patch[db_key] = val

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
