-- Run this in the Supabase SQL Editor after the initial setup.
-- Adds a projects table and links time_entries to it.

create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  color text not null default '#2dd4bf',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now(),
  archived boolean default false
);

create index if not exists projects_archived_idx on projects (archived);

alter table time_entries
  add column if not exists project_id uuid references projects(id) on delete set null;

alter table projects enable row level security;

drop policy if exists "read all projects" on projects;
create policy "read all projects" on projects
  for select to authenticated using (true);

drop policy if exists "insert projects" on projects;
create policy "insert projects" on projects
  for insert to authenticated with check (auth.uid() = created_by);

drop policy if exists "update projects" on projects;
create policy "update projects" on projects
  for update to authenticated using (true);

drop policy if exists "delete own projects" on projects;
create policy "delete own projects" on projects
  for delete to authenticated using (auth.uid() = created_by);

do $$ begin
  alter publication supabase_realtime add table projects;
exception when duplicate_object then null; end $$;
