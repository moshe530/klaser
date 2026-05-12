-- ============================================================
-- Klaser — user_preferences table
-- ------------------------------------------------------------
-- A generic per-user key/value store (value is JSONB).
-- Used initially for:
--   * categories       — user's category list (canonical names + metadata)
--   * custom_tabs      — ordered list of custom subnav tabs
--   * sub_branches     — per-category sub-branches map
-- Future keys are free to add without schema changes.
-- ============================================================

create table if not exists public.user_preferences (
  user_id  uuid        not null references public.users(id) on delete cascade,
  key      text        not null,
  value    jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create index if not exists user_preferences_user_id_idx
  on public.user_preferences (user_id);

-- ─── RLS ───────────────────────────────────────────────────────
alter table public.user_preferences enable row level security;

drop policy if exists "user_preferences_select_own"  on public.user_preferences;
drop policy if exists "user_preferences_insert_own"  on public.user_preferences;
drop policy if exists "user_preferences_update_own"  on public.user_preferences;
drop policy if exists "user_preferences_delete_own"  on public.user_preferences;

create policy "user_preferences_select_own"
  on public.user_preferences for select
  using (auth.uid() = user_id);

create policy "user_preferences_insert_own"
  on public.user_preferences for insert
  with check (auth.uid() = user_id);

create policy "user_preferences_update_own"
  on public.user_preferences for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_preferences_delete_own"
  on public.user_preferences for delete
  using (auth.uid() = user_id);

-- ─── Auto-update `updated_at` on row update ────────────────────
create or replace function public.touch_user_preferences_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_user_preferences_updated_at on public.user_preferences;
create trigger trg_user_preferences_updated_at
  before update on public.user_preferences
  for each row execute function public.touch_user_preferences_updated_at();
