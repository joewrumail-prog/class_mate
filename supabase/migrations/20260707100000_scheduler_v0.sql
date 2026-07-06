-- Scheduler v0 data layer (PRODUCT-V1 §3: time x energy OS).
--
-- Tables: commitments, tasks, schedule_blocks, energy_reports, campus_commute.
-- canvas_connections is intentionally NOT here — it ships in the Canvas
-- integration migration.
--
-- Privacy red lines (PRODUCT-V1 §7):
--  - §7.1 location: campus-level granularity ONLY (never room-level), serves
--    the owner's scheduling exclusively, and is never visible to other users
--    or to Room. Enforced here via owner-only RLS on schedule_blocks.
--  - §7.5 energy_reports is HEALTH-ADJACENT data: it lives in the scheduling
--    domain only — never fed to analytics platforms, never surfaced in Room,
--    never visible to other users. It is exported and deleted with the
--    account (on delete cascade + owner-only RLS).
--
-- Writes happen exclusively through the API service role (bypasses RLS).
-- Clients get owner-scoped SELECT only; campus_commute is authenticated-read
-- reference data. No client write policies anywhere.
--
-- users.settings JSONB (column added in 20260705150100_system_ui.sql) gains
-- these documented keys, read by the scheduling engine (PRODUCT-V1 §3.3):
--   sleep_start  "HH:MM"  default "00:30"  -- sleep window start
--   sleep_end    "HH:MM"  default "08:30"  -- sleep window end
--   home_campus  one of: college_ave | busch | livingston | cook_douglass

-- -------------------------------------------------------------- commitments
-- User-entered long-term commitments (§3.1): gym plans, clubs, work shifts,
-- self-set goals. The scheduler expands these into tasks each week.
create table if not exists commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('gym', 'club', 'work', 'goal', 'custom')),
  title text not null,
  frequency_per_week int not null default 1,
  duration_minutes int not null default 60,
  intensity int not null default 3 check (intensity between 1 and 5),
  -- e.g. [{"day": "mon", "start": "18:00", "end": "21:00"}] — soft preference
  -- windows the fill pass tries first.
  preferred_windows jsonb not null default '[]'::jsonb,
  -- Free-text long-term goal narrative Atlas references in weekly reviews.
  long_term_note text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create index if not exists idx_commitments_user_active
  on commitments (user_id)
  where active;

-- -------------------------------------------------------------------- tasks
-- Unified task pool the engine schedules from: Canvas assignments,
-- commitment-expanded instances, and manual entries.
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  source text not null check (source in ('canvas', 'commitment', 'manual')),
  -- Stable upstream id (Canvas assignment id, commitment occurrence key).
  -- Paired with the partial unique index below so re-syncs upsert instead
  -- of duplicating.
  source_ref text,
  title text not null,
  estimated_minutes int not null default 30,
  intensity int not null default 3 check (intensity between 1 and 5),
  due_at timestamptz,
  status text not null default 'pending'
    check (status in ('pending', 'scheduled', 'done', 'dropped')),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Idempotent ingestion: one task per (user, source, upstream ref).
create unique index if not exists uq_tasks_user_source_ref
  on tasks (user_id, source, source_ref)
  where source_ref is not null;

create index if not exists idx_tasks_user_status
  on tasks (user_id, status);

-- ----------------------------------------------------------- schedule_blocks
-- Block calendar (§3.5): engine-planned blocks + user manual blocks coexist.
-- Reschedules only touch the future — past rows are history and keep their
-- status (planned/done/missed/moved) for completion-rate metrics (§6).
create table if not exists schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  task_id uuid references tasks(id) on delete set null,
  title text not null,
  kind text not null
    check (kind in ('class', 'commute', 'task', 'manual', 'protected')),
  plan_date date not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  -- §7.1: campus-level location ONLY (college_ave/busch/livingston/
  -- cook_douglass), never room-level. Used solely for the owner's commute
  -- math; owner-only RLS means no other user can ever read it.
  campus text,
  -- Locked blocks survive automatic reschedules (user pinned them).
  locked boolean not null default false,
  status text not null default 'planned'
    check (status in ('planned', 'done', 'missed', 'moved')),
  -- Atlas's one-line explanation for why this block is here (§3.4).
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists idx_schedule_blocks_user_date
  on schedule_blocks (user_id, plan_date);

-- ------------------------------------------------------------ energy_reports
-- §7.5 HEALTH-ADJACENT: daily 1-5 self-report (§3.3), one per day. Used only
-- as the day's energy-budget multiplier and the protection-mode /
-- weekly-fill-reduction triggers. Never leaves the scheduling domain: no
-- analytics platform, no Room, no other users. Exported/deleted with the
-- account.
create table if not exists energy_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  report_date date not null,
  score int not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  unique (user_id, report_date)
);

-- ------------------------------------------------------------ campus_commute
-- Symmetric campus-pair bus-minutes matrix for Rutgers New Brunswick.
-- Reference data (no user rows): the engine's hard-constraint pass inserts
-- commute buffer blocks between classes on different campuses (§3.2).
create table if not exists campus_commute (
  campus_a text not null,
  campus_b text not null,
  minutes int not null,
  primary key (campus_a, campus_b)
);

-- Values are PROVISIONAL pending Rutgers bus GTFS calibration (PRODUCT-V1
-- §9). Both directions seeded explicitly so lookups never need to swap
-- arguments; same-campus pairs are 0.
insert into campus_commute (campus_a, campus_b, minutes) values
  ('college_ave',   'college_ave',   0),
  ('busch',         'busch',         0),
  ('livingston',    'livingston',    0),
  ('cook_douglass', 'cook_douglass', 0),
  ('college_ave',   'busch',         20),
  ('busch',         'college_ave',   20),
  ('college_ave',   'livingston',    25),
  ('livingston',    'college_ave',   25),
  ('college_ave',   'cook_douglass', 15),
  ('cook_douglass', 'college_ave',   15),
  ('busch',         'livingston',    10),
  ('livingston',    'busch',         10),
  ('busch',         'cook_douglass', 30),
  ('cook_douglass', 'busch',         30),
  ('livingston',    'cook_douglass', 30),
  ('cook_douglass', 'livingston',    30)
on conflict (campus_a, campus_b) do nothing;

-- ---------------------------------------------------------------------- RLS
alter table commitments enable row level security;
alter table tasks enable row level security;
alter table schedule_blocks enable row level security;
alter table energy_reports enable row level security;
alter table campus_commute enable row level security;

-- Owner-only reads; all writes go through the API service role (bypasses
-- RLS). No client write policies by design.
drop policy if exists commitments_owner_select on commitments;
create policy commitments_owner_select on commitments
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists tasks_owner_select on tasks;
create policy tasks_owner_select on tasks
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists schedule_blocks_owner_select on schedule_blocks;
create policy schedule_blocks_owner_select on schedule_blocks
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists energy_reports_owner_select on energy_reports;
create policy energy_reports_owner_select on energy_reports
  for select to authenticated
  using (auth.uid() = user_id);

-- Commute matrix is non-sensitive reference data: any signed-in user can
-- read it; only the service role writes it.
drop policy if exists campus_commute_authenticated_select on campus_commute;
create policy campus_commute_authenticated_select on campus_commute
  for select to authenticated
  using (true);
