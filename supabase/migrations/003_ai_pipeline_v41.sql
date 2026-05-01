-- ============================================================
-- Klaser — AI Pipeline v4.1 additions
-- Adds structured metadata from Classifier + Extractor + guards.
-- Safe to re-run (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
-- ============================================================

alter table public.documents
  -- Classifier output
  add column if not exists doc_type_detected text,
  add column if not exists confidence        text
    check (confidence is null or confidence in ('high', 'medium', 'low')),
  add column if not exists confidence_reason text,
  add column if not exists needs_review      boolean not null default false,
  add column if not exists ocr_quality       text
    check (ocr_quality is null or ocr_quality in ('high', 'medium', 'low')),
  add column if not exists language          text
    check (language is null or language in ('he', 'en', 'mixed', 'unknown')),
  add column if not exists structure         text
    check (structure is null or structure in ('table', 'form', 'free_text', 'mixed', 'unknown')),

  -- Extractor output (per-document)
  add column if not exists document_type     text,
  add column if not exists merchant          text,
  add column if not exists amount_candidates jsonb not null default '[]'::jsonb,
  add column if not exists amount_labels     jsonb not null default '[]'::jsonb,
  add column if not exists document_period   jsonb,

  -- Pipeline meta
  add column if not exists file_hash         text;

-- Helpful indexes
create index if not exists documents_needs_review_idx
  on public.documents(user_id, needs_review) where needs_review = true;

create index if not exists documents_doc_type_detected_idx
  on public.documents(doc_type_detected);

create index if not exists documents_file_hash_idx
  on public.documents(user_id, file_hash) where file_hash is not null;
