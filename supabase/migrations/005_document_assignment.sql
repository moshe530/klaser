-- ============================================================
-- 005_document_assignment.sql
-- ------------------------------------------------------------
-- Adds per-document person/profile assignment so users can
-- filter documents by family member (or business contact).
--
-- Why a plain text column instead of a foreign key to a
-- `profiles` table?
--   - The "family profile" data currently lives client-side in
--     localStorage (`klaser_family_profiles`) and syncs through
--     `user_preferences` (see migration 004). There is no
--     server-side `profiles` table to FK to.
--   - Storing the profile's stable `id` string (UUID-like)
--     keeps it consistent and lets us migrate to a real FK
--     later without data loss.
--   - We also store `assigned_profile_name` as a snapshot so
--     the UI can render the chip even if the profile was
--     deleted client-side on another device (graceful
--     degradation).
-- ============================================================

alter table public.documents
  add column if not exists assigned_profile_id   text,
  add column if not exists assigned_profile_name text;

-- Lookups by profile (e.g. "show all docs for דני") use this.
create index if not exists documents_assigned_profile_id_idx
  on public.documents(user_id, assigned_profile_id)
  where assigned_profile_id is not null;
