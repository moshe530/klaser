from datetime import date, datetime
from typing import Any, Literal, Optional
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


# ============================================================
# Documents
# ============================================================
class DocumentBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=255)
    category: Optional[str] = None
    sub_category: Optional[str] = None
    purchase_date: Optional[date] = None
    warranty_end: Optional[date] = None
    amount: Optional[float] = None
    tags: list[str] = Field(default_factory=list)


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
