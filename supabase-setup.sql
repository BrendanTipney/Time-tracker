-- Run this in the Supabase SQL Editor (SQL Editor → New Query → paste → Run).

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  color text default '#14b8a6',
  created_at timestamptz default now()
);

create table if not exists time_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz,
  task text default '',
  created_at timestamptz default now()
);

create index if not exists time_entries_started_at_idx
  on time_entries (started_at desc);
create index if not exists time_entries_user_id_idx
  on time_entries (user_id);

alter table profiles enable row level security;
alter table time_entries enable row level security;

-- Both partners can see each other's entries + profiles.
drop policy if exists "read all profiles" on profiles;
create policy "read all profiles" on profiles
  for select to authenticated using (true);

drop policy if exists "insert own profile" on profiles;
create policy "insert own profile" on profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "update own profile" on profiles;
create policy "update own profile" on profiles
  for update to authenticated using (auth.uid() = id);

drop policy if exists "read all entries" on time_entries;
create policy "read all entries" on time_entries
  for select to authenticated using (true);

drop policy if exists "insert own entries" on time_entries;
create policy "insert own entries" on time_entries
  for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "update own entries" on time_entries;
create policy "update own entries" on time_entries
  for update to authenticated using (auth.uid() = user_id);

drop policy if exists "delete own entries" on time_entries;
create policy "delete own entries" on time_entries
  for delete to authenticated using (auth.uid() = user_id);

-- Auto-create a profile row whenever a new user signs up.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Enable Realtime on these tables so the client sees live updates (idempotent).
do $$ begin
  alter publication supabase_realtime add table time_entries;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table profiles;
exception when duplicate_object then null; end $$;
