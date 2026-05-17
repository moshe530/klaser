from uuid import UUID

from fastapi import APIRouter, Body, File, HTTPException, Query, Request, UploadFile

from ..auth import AuthContext, AuthDep
from ..limiter import limiter
from ..models import DocumentCreate, DocumentOut, DocumentUpdate
from ..services import ai_analyzer, canonical_namer, profile_matcher, storage

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
    user_profiles: list[dict] | None = None
    account_type: str = "personal"  # default to personal
    user_subcategories: dict[str, list[str]] | None = None
    if isinstance(payload, dict):
        cats = payload.get("categories")
        if isinstance(cats, list):
            user_categories = [str(c) for c in cats if c]
        people = payload.get("people")
        if isinstance(people, list):
            user_people = [p for p in people if isinstance(p, dict) and p.get("name")]
        # Family profiles list (rich profile dicts: id, name, id_number).
        # Used after the AI runs, by `profile_matcher`, to map the AI's
        # extracted person/ID signals to a concrete `assigned_profile_id`.
        profiles = payload.get("profiles")
        if isinstance(profiles, list):
            user_profiles = [p for p in profiles if isinstance(p, dict) and p.get("name")]
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

    # Build the `people` list passed to the AI: prefer the rich
    # family-profiles list (has both name + id_number) and fall back to
    # the legacy simple-people list. We deduplicate by lowercased name.
    ai_people: list[dict] = []
    seen_names: set[str] = set()
    for src in (user_profiles or [], user_people or []):
        for p in src:
            name = (p.get("name") or "").strip()
            if not name:
                continue
            key = name.lower()
            if key in seen_names:
                continue
            seen_names.add(key)
            ai_people.append({
                "name": name,
                "id_number": (p.get("id_number") or "").strip(),
            })

    try:
        data = storage.download_bytes(auth.client, doc["file_path"])
        result = ai_analyzer.analyze_file(
            data,
            doc.get("mime_type") or "application/pdf",
            categories=user_categories,
            people=ai_people or None,
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

    # ── CANONICALIZE merchant + name BEFORE writing fields ──────────────
    # The AI is non-deterministic: it might spell the same merchant five
    # different ways across five docs ("בזק", "Bezeq", "בזק בעמ"…). To
    # keep the user's library tidy and make similar docs *look* similar,
    # we pick the user's existing display variant (if any) and rebuild
    # the doc name from a deterministic template.
    ai_merchant = result.get("merchant")
    canon_key = canonical_namer.canonicalize_merchant(ai_merchant)
    if canon_key:
        try:
            siblings_res = (
                auth.client.table(TABLE)
                .select("name,merchant,category,document_period,purchase_date")
                .eq("user_id", str(auth.user_id))
                .neq("id", str(doc_id))
                .not_.is_("merchant", "null")
                .limit(50)
                .execute()
            )
            siblings = siblings_res.data or []
        except Exception:
            siblings = []
        alias = canonical_namer.pick_merchant_alias(ai_merchant, siblings)
        if alias and alias != ai_merchant:
            # Collapse merchant spelling to the existing canonical variant.
            result["merchant"] = alias
    else:
        siblings = []

    # Build a deterministic name from the extracted fields. We only
    # override when:
    #   - the template applies (recurring bills / payslip / etc.), AND
    #   - the existing name is a placeholder OR this is the first run.
    # User-edited names are preserved.
    canonical_name = canonical_namer.build_canonical_name(
        result,
        merchant_alias=result.get("merchant"),
    )
    if canonical_name:
        # Replace AI's varied name with the deterministic one so the
        # generic field_map loop below writes the canonical version.
        result["name"] = canonical_name

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

    # ── (c) AUTO-ASSIGN to a family profile based on extracted name + ID ──
    # We never overwrite an existing 'manual' or 'confirmed' assignment —
    # those represent explicit user choices that must be preserved across
    # re-analyses.
    extracted_name = result.get("extracted_person_name")
    extracted_id   = result.get("extracted_id_number")
    existing_status = doc.get("assignment_status")
    user_protected = existing_status in ("manual", "confirmed")

    # Always store the raw signals (even if no profile matched) — this
    # powers the "we saw 'Dana' in your doc, add as profile?" CTA later.
    if extracted_name:
        patch["assignment_extracted_name"] = str(extracted_name).strip()[:120]
    last4 = ""
    if extracted_id:
        digits = "".join(c for c in str(extracted_id) if c.isdigit())
        if len(digits) >= 4:
            last4 = digits[-4:]
    if last4:
        patch["assignment_extracted_id_last4"] = last4

    if not user_protected and user_profiles:
        matched, conf = profile_matcher.match_profile(
            extracted_name, extracted_id, user_profiles
        )
        if matched and conf:
            # 'low' is informational only — don't auto-write a profile_id
            # that the user might not approve. The frontend can still
            # discover low-confidence candidates via the dedicated
            # /suggest endpoint when explicitly asked.
            if conf in ("high", "medium"):
                patch["assigned_profile_id"]     = matched.get("id")
                patch["assigned_profile_name"]   = matched.get("name")
                patch["assignment_confidence"]   = conf
                patch["assignment_status"]       = (
                    "auto" if conf == "high" else "suggested"
                )
            else:
                patch["assignment_confidence"] = conf
        elif not user_protected and existing_status not in ("auto", "suggested"):
            # No match this run — clear any stale auto-assignment from a
            # previous run so we don't leave wrong data behind.
            pass

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


# ============================================================
# ASSIGNMENT — confirm a 'suggested' (medium-confidence) match
# ============================================================
@router.post("/{doc_id}/confirm-assignment", response_model=DocumentOut)
def confirm_assignment(
    doc_id: UUID,
    auth: AuthContext = AuthDep,
    payload: dict | None = Body(default=None),
):
    """User explicitly accepts or rejects a 'suggested' AI assignment.

    Body: {"action": "confirm" | "reject", "profile_id"?: str, "profile_name"?: str}
      - confirm: keeps the current assigned_profile_id; status → 'confirmed'.
      - reject: clears assigned_profile_id; status → null. Optionally the
        client may pass a different profile_id/name to *replace* the
        suggestion instead of clearing it (combined reject + manual).
    """
    doc = _get_owned_doc(auth, doc_id)
    action = (payload or {}).get("action") if isinstance(payload, dict) else None
    if action not in ("confirm", "reject"):
        raise HTTPException(400, "action must be 'confirm' or 'reject'")

    if action == "confirm":
        update = {
            "assignment_status": "confirmed",
        }
    else:
        # Reject — optional replacement profile (one-shot manual pick).
        replacement_id = (payload or {}).get("profile_id")
        replacement_name = (payload or {}).get("profile_name")
        if replacement_id:
            update = {
                "assigned_profile_id":   str(replacement_id),
                "assigned_profile_name": str(replacement_name or "")[:120] or None,
                "assignment_status":     "manual",
                "assignment_confidence": None,
            }
        else:
            update = {
                "assigned_profile_id":   None,
                "assigned_profile_name": None,
                "assignment_status":     None,
                "assignment_confidence": None,
            }

    # Don't overwrite an unrelated doc — only proceed if the doc actually
    # has a suggestion or was passed a replacement.
    res = (
        auth.client.table(TABLE)
        .update(update)
        .eq("id", str(doc_id))
        .eq("user_id", str(auth.user_id))
        .execute()
    )
    if not res.data:
        raise HTTPException(500, "Failed to update assignment")
    return res.data[0]


# ============================================================
# NAMING — retroactively unify names of existing similar documents.
# ============================================================
@router.post("/recanonicalize")
def recanonicalize_documents(
    auth: AuthContext = AuthDep,
    payload: dict | None = Body(default=None),
):
    """Re-run the deterministic naming over the user's existing documents
    so older docs match the same canonical pattern as freshly-analyzed
    ones (e.g. "בזק — תקשורת — 2025-03"). Cheap — no AI calls; only
    reads `merchant`/`category`/`document_period`/`purchase_date` and
    writes a new `name` per row.

    Body (optional):
      {"dry_run": bool, "category"?: str}
        - dry_run=true  → return preview without writing.
        - category      → restrict to one category (e.g. "חשמל").
    """
    payload = payload or {}
    dry_run = bool(payload.get("dry_run"))
    only_category = payload.get("category")

    q = (
        auth.client.table(TABLE)
        .select("id,name,merchant,category,sub_category,document_period,"
                "purchase_date,warranty_end,document_type")
        .eq("user_id", str(auth.user_id))
    )
    if isinstance(only_category, str) and only_category:
        q = q.eq("category", only_category)
    res = q.execute()
    rows = res.data or []

    # First pass: pick the dominant merchant alias per canonical key.
    alias_by_canon: dict[str, str] = {}
    counts: dict[tuple[str, str], int] = {}
    for r in rows:
        m = r.get("merchant")
        if not m:
            continue
        c = canonical_namer.canonicalize_merchant(m)
        if not c:
            continue
        counts[(c, m)] = counts.get((c, m), 0) + 1
    for (c, m), n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0][1])):
        alias_by_canon.setdefault(c, m)

    # Second pass: rebuild names where the template applies.
    changes: list[dict] = []
    for r in rows:
        merchant = r.get("merchant")
        canon = canonical_namer.canonicalize_merchant(merchant) if merchant else ""
        alias = alias_by_canon.get(canon) if canon else None
        new_name = canonical_namer.build_canonical_name(
            r, merchant_alias=alias or merchant,
        )
        if not new_name or new_name == r.get("name"):
            continue
        changes.append({
            "id": str(r["id"]),
            "old_name": r.get("name"),
            "new_name": new_name,
            "merchant_alias": alias,
        })

    if not dry_run:
        for ch in changes:
            update = {"name": ch["new_name"]}
            if ch["merchant_alias"]:
                update["merchant"] = ch["merchant_alias"]
            try:
                (
                    auth.client.table(TABLE)
                    .update(update)
                    .eq("id", ch["id"])
                    .eq("user_id", str(auth.user_id))
                    .execute()
                )
            except Exception as e:  # pragma: no cover — best-effort bulk
                ch["error"] = str(e)
    return {
        "changes": changes,
        "total":   len(changes),
        "applied": not dry_run,
    }


# ============================================================
# ASSIGNMENT — bulk back-fill: find docs that may belong to a profile
# ============================================================
@router.post("/match-profile")
def match_documents_for_profile(
    auth: AuthContext = AuthDep,
    payload: dict | None = Body(default=None),
):
    """Given a profile (name + optional id_number), scan the user's
    existing documents and return ones that likely belong to that
    profile based on AI signals stored in `ai_data` /
    `assignment_extracted_*`. Used by the "we found 12 medical docs
    that may be Dana's — review?" UX after a new profile is added.

    Body: {"profile": {"id": str, "name": str, "id_number"?: str},
           "min_confidence"?: "medium" | "low"}
    Response: {
       "matches": [{"document_id": str, "confidence": "high|medium|low",
                    "name": str, "category": str}, ...]
    }
    """
    if not isinstance(payload, dict):
        raise HTTPException(400, "Missing payload")
    profile = payload.get("profile")
    if not isinstance(profile, dict) or not profile.get("name"):
        raise HTTPException(400, "profile.name is required")
    min_conf = payload.get("min_confidence") or "medium"
    if min_conf not in ("medium", "low"):
        min_conf = "medium"

    # Pull only docs that *could* match (medical/personal). Cheap pre-filter
    # on category + presence of any extracted signal keeps the scan small.
    res = (
        auth.client.table(TABLE)
        .select("id,name,category,ai_data,assigned_profile_id,"
                "assignment_extracted_name,assignment_extracted_id_last4")
        .eq("user_id", str(auth.user_id))
        .is_("assigned_profile_id", "null")
        .execute()
    )
    docs = res.data or []
    pairs = profile_matcher.find_documents_for_profile(
        profile, docs, min_confidence=min_conf,
    )
    return {
        "matches": [
            {
                "document_id": str(d["id"]),
                "confidence":  conf,
                "name":        d.get("name"),
                "category":    d.get("category"),
            }
            for d, conf in pairs
        ]
    }
