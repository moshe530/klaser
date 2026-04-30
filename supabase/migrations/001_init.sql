-- ============================================================
-- Klaser — initial schema
-- Run this in Supabase SQL Editor (one-shot).
-- ============================================================

-- Extensions
create extension if not exists "pgcrypto";

-- ============================================================
-- USERS (profile rows linked to auth.users)
-- ============================================================
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  phone text,
  name text,
  notification_prefs jsonb not null default '{"email": true, "whatsapp": false}'::jsonb,
  created_at timestamptz not null default now()
);

-- Auto-create profile row on signup
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

-- ============================================================
-- DOCUMENTS
-- ============================================================
create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  category text,
  sub_category text,
  purchase_date date,
  warranty_end date,
  amount numeric(12, 2),
  file_path text,
  file_size bigint,
  mime_type text,
  ocr_text text,
  ocr_status text not null default 'pending'
    check (ocr_status in ('pending', 'processing', 'done', 'failed', 'skipped')),
  ai_data jsonb,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists documents_user_id_idx on public.documents(user_id);
create index if not exists documents_category_idx on public.documents(category);
create index if not exists documents_warranty_end_idx on public.documents(warranty_end);

-- ============================================================
-- REMINDERS
-- ============================================================
create table if not exists public.reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  doc_id uuid references public.documents(id) on delete cascade,
  type text not null,
  name text not null,
  remind_at timestamptz not null,
  channel text not null default 'email'
    check (channel in ('email', 'whatsapp', 'push')),
  status text not null default 'pending'
    check (status in ('pending', 'sent', 'failed', 'cancelled')),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists reminders_user_id_idx on public.reminders(user_id);
create index if not exists reminders_remind_at_idx on public.reminders(remind_at)
  where status = 'pending';

-- ============================================================
-- updated_at trigger
-- ============================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists documents_updated_at on public.documents;
create trigger documents_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.users enable row level security;
alter table public.documents enable row level security;
alter table public.reminders enable row level security;

-- USERS: each user reads/updates their own profile
drop policy if exists "users_self_select" on public.users;
create policy "users_self_select" on public.users
  for select using (auth.uid() = id);

drop policy if exists "users_self_update" on public.users;
create policy "users_self_update" on public.users
  for update using (auth.uid() = id);

-- DOCUMENTS: full CRUD on own rows
drop policy if exists "documents_owner_all" on public.documents;
create policy "documents_owner_all" on public.documents
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- REMINDERS: full CRUD on own rows
drop policy if exists "reminders_owner_all" on public.reminders;
create policy "reminders_owner_all" on public.reminders
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
