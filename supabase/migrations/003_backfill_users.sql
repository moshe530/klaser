-- ============================================================
-- Klaser — backfill public.users from auth.users
-- Run in Supabase SQL Editor.
-- Fixes: users who signed up before the on_auth_user_created trigger
-- was active end up without a public.users row, causing FK errors
-- on reminders/documents with "Key is not present in table users".
-- ============================================================

-- 1. Backfill any missing profile rows
insert into public.users (id, email)
select id, email
from auth.users
on conflict (id) do nothing;

-- 2. Ensure the auto-insert trigger is installed (idempotent)
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
