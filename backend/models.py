from datetime import date, datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ============================================================
# Documents
# ============================================================
# AI pipeline enums (free-form in DB via CHECK constraints)
Confidence = Literal["high", "medium", "low"]
OcrQuality = Literal["high", "medium", "low"]
Language   = Literal["he", "en", "mixed", "unknown"]
Structure  = Literal["table", "form", "free_text", "mixed", "unknown"]


class DocumentBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    category: Optional[str] = None
    sub_category: Optional[str] = None
    purchase_date: Optional[date] = None
    warranty_end: Optional[date] = None
    amount: Optional[float] = None
    tags: list[str] = Field(default_factory=list)

    # Assignment to a family profile / business contact. The id is the
    # client-side profile id from `klaser_family_profiles` (synced via
    # user_preferences). The name is stored as a denormalized snapshot so
    # the UI can still render the chip if the profile was deleted on
    # another device. Both are nullable.
    assigned_profile_id: Optional[str] = None
    assigned_profile_name: Optional[str] = None

    # AI-driven assignment metadata (see migration 006).
    # confidence: 'high' | 'medium' | 'low' | None
    # status:     'auto' | 'suggested' | 'confirmed' | 'manual' | None
    assignment_confidence: Optional[str] = None
    assignment_status: Optional[str] = None
    # Raw signals extracted from the document (used by back-fill UX and
    # transparency banners). The ID column stores ONLY the last 4 digits.
    assignment_extracted_name: Optional[str] = None
    assignment_extracted_id_last4: Optional[str] = None

    # Extractor output (per-document details)
    document_type: Optional[str] = None
    merchant: Optional[str] = None
    amount_candidates: list[float] = Field(default_factory=list)
    amount_labels: list[str] = Field(default_factory=list)
    document_period: Optional[dict[str, Any]] = None


class DocumentCreate(DocumentBase):
    pass


class DocumentUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=255)
    category: Optional[str] = None
    sub_category: Optional[str] = None
    purchase_date: Optional[date] = None
    warranty_end: Optional[date] = None
    amount: Optional[float] = None
    tags: Optional[list[str]] = None
    # Assignment to a family profile (see DocumentBase for the rationale).
    assigned_profile_id: Optional[str] = None
    assigned_profile_name: Optional[str] = None
    # When the user manually edits assignment, the frontend sets status
    # to 'manual' so re-runs of the AI don't override it.
    assignment_status: Optional[str] = None
    assignment_confidence: Optional[str] = None
    document_type: Optional[str] = None
    merchant: Optional[str] = None
    amount_candidates: Optional[list[float]] = None
    amount_labels: Optional[list[str]] = None
    document_period: Optional[dict[str, Any]] = None


class DocumentOut(DocumentBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    file_path: Optional[str] = None
    file_size: Optional[int] = None
    mime_type: Optional[str] = None
    ocr_text: Optional[str] = None
    ocr_status: str = "pending"
    ai_data: Optional[dict[str, Any]] = None

    # Classifier output
    doc_type_detected: Optional[str] = None
    confidence: Optional[Confidence] = None
    confidence_reason: Optional[str] = None
    needs_review: bool = False
    ocr_quality: Optional[OcrQuality] = None
    language: Optional[Language] = None
    structure: Optional[Structure] = None

    # Pipeline meta
    file_hash: Optional[str] = None

    created_at: datetime
    updated_at: datetime


# ============================================================
# Reminders
# ============================================================
ReminderChannel = Literal["email", "whatsapp", "push"]
ReminderStatus = Literal["pending", "sent", "failed", "cancelled"]


class ReminderBase(BaseModel):
    type: str = Field(..., min_length=1, max_length=50)
    name: str = Field(..., min_length=1, max_length=255)
    remind_at: datetime
    channel: ReminderChannel = "email"
    doc_id: Optional[UUID] = None


class ReminderCreate(ReminderBase):
    pass


class ReminderUpdate(BaseModel):
    type: Optional[str] = None
    name: Optional[str] = None
    remind_at: Optional[datetime] = None
    channel: Optional[ReminderChannel] = None
    status: Optional[ReminderStatus] = None


class ReminderOut(ReminderBase):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    user_id: UUID
    status: ReminderStatus
    sent_at: Optional[datetime] = None
    created_at: datetime
