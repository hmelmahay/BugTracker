-- ── Bug Tracker: Supabase Setup ──────────────────────────────────────────────
-- Run this in your Supabase project → SQL Editor → New Query

-- Team members (the assignee dropdown is populated from this table)
create table team_members (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  email      text,
  created_at timestamptz default now()
);

-- Bugs
create table bugs (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  severity    text not null default 'Medium',
  status      text not null default 'open',
  assigned_to text,
  reporter    text,
  steps       text,
  notes       text,
  created_at  timestamptz default now()
);

-- Row Level Security: any authenticated user can read/write everything
alter table team_members enable row level security;
alter table bugs enable row level security;

create policy "auth_all_team_members"
  on team_members for all
  to authenticated
  using (true)
  with check (true);

create policy "auth_all_bugs"
  on bugs for all
  to authenticated
  using (true)
  with check (true);

-- ── Seed your team members ────────────────────────────────────────────────────
-- Edit these names/emails to match your actual team, then run this block.
-- You can also add more rows later via the Supabase Table Editor.

insert into team_members (name, email) values
  ('Steve',        'pokerdad123@gmail.com'),
  ('Team Member 2', 'member2@example.com'),
  ('Team Member 3', 'member3@example.com');
