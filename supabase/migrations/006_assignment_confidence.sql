-- ============================================================
-- 006_assignment_confidence.sql
-- ------------------------------------------------------------
-- Adds confidence tracking for the AI-driven family-member
-- assignment of documents (medical tab in particular).
--
-- The AI extracts a person name and ID number from each document
-- (see ai_extractor.py rule #7) and the backend `profile_matcher`
-- service compares them against the user's family_profiles to
-- compute a confidence level.
--
-- Columns:
--   - assignment_confidence  text  ('high'|'medium'|'low'|null)
--       null = no AI assignment was attempted (e.g. user picked
--              the profile manually, or the doc isn't medical).
--       high   = ID match (effectively certain).
--       medium = strong name match without ID confirmation.
--       low    = weak signal — NOT auto-assigned, just suggested.
--   - assignment_status      text  ('auto'|'suggested'|'confirmed'|'manual')
--       auto      = high-confidence; written silently with toast.
--       suggested = medium-confidence; profile_id is set but the
--                   UI shows a banner asking the user to confirm.
--       confirmed = user explicitly accepted a 'suggested' match.
--       manual    = user picked the profile themselves (no AI).
--   - assignment_extracted_name      text  raw name signal from doc
--   - assignment_extracted_id_last4  text  last 4 digits only (privacy)
--       Stored at the top level (in addition to the full extraction
--       which lives in ai_data jsonb) so the back-fill query can
--       index-scan candidates without deserializing ai_data per row.
--       We deliberately store ONLY the last 4 digits here — the full
--       9-digit ID never leaves the analysis path. Partial match on
--       last 4 is enough for the back-fill suggestion UX.
-- ============================================================

alter table public.documents
  add column if not exists assignment_confidence    text,
  add column if not exists assignment_status        text,
  add column if not exists assignment_extracted_name      text,
  add column if not exists assignment_extracted_id_last4  text;

-- Soft constraints — using CHECK so a misbehaving client can't
-- write garbage values.
alter table public.documents
  drop constraint if exists documents_assignment_confidence_check;
alter table public.documents
  add constraint documents_assignment_confidence_check
  check (assignment_confidence is null
         or assignment_confidence in ('high', 'medium', 'low'));

alter table public.documents
  drop constraint if exists documents_assignment_status_check;
alter table public.documents
  add constraint documents_assignment_status_check
  check (assignment_status is null
         or assignment_status in ('auto', 'suggested', 'confirmed', 'manual'));

-- Index used by the "review pending suggestions" UI banner.
create index if not exists documents_assignment_suggested_idx
  on public.documents(user_id)
  where assignment_status = 'suggested';
