-- Baymax cloud sync schema. Run once in Supabase → SQL Editor (or via the Management API).
-- One row per synced item (task, note, spend, EMI…). Only the signed-in owner can read or write
-- their rows (row level security). server_at is set by the database and used as the sync cursor.

create table if not exists public.records (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  coll       text        not null,
  id         text        not null,
  data       jsonb,
  deleted    boolean     not null default false,
  updated_at timestamptz not null default now(),
  server_at  timestamptz not null default now(),
  primary key (user_id, coll, id)
);

create index if not exists records_user_server_at on public.records (user_id, server_at);

create or replace function public.records_set_server_at() returns trigger
language plpgsql as $$
begin
  new.server_at := now();
  return new;
end $$;

drop trigger if exists records_server_at on public.records;
create trigger records_server_at before insert or update on public.records
  for each row execute function public.records_set_server_at();

alter table public.records enable row level security;

drop policy if exists "owner can read" on public.records;
drop policy if exists "owner can insert" on public.records;
drop policy if exists "owner can update" on public.records;
drop policy if exists "owner can delete" on public.records;
create policy "owner can read"   on public.records for select using (auth.uid() = user_id);
create policy "owner can insert" on public.records for insert with check (auth.uid() = user_id);
create policy "owner can update" on public.records for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "owner can delete" on public.records for delete using (auth.uid() = user_id);

-- Realtime: devices hear each other's changes instantly.
do $$ begin
  alter publication supabase_realtime add table public.records;
exception when duplicate_object then null; end $$;

-- Server-only secrets (e.g. the Zoho refresh token). No policies = no access for app users;
-- only the server functions (service role key) can read or write it.
create table if not exists public.secrets (
  name       text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.secrets enable row level security;
