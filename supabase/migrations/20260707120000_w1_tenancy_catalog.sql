-- ============================================================================
-- W1 (DEV-SPEC-V1 §11): tenancy (schools/terms) + SOC course catalog + plans
-- + checkin / plan-block extensions + encrypted contact handles.
--
-- ADAPTATION NOTES (user-approved deviations from DEV-SPEC-V1 §1 naming):
--  * catalog_ prefix — the spec's courses / sections / section_meetings
--    collide with the LIVE `courses` table (the user-import domain created in
--    001_complete_schema.sql, untouched here). The SOC-adapter-owned catalog
--    therefore ships as catalog_courses / catalog_sections /
--    catalog_section_meetings.
--  * spec `checkins` = existing energy_reports EXTENDED (adds sleep_h, mood).
--    One row per user per day is already enforced there
--    (unique(user_id, report_date) in 20260707100000_scheduler_v0.sql).
--  * spec `plan_blocks` = existing schedule_blocks EXTENDED (adds
--    reason_effect, shed_reason; the status check gains 'shed'). The existing
--    `reason` column plays the spec's reason_signal role.
--  * spec users profile fields (major, grad_year, goal_archetype, sleep
--    window, timezone, ...) stay in users.settings jsonb (column added in
--    20260705150100_system_ui.sql) — least-change; only school_id becomes a
--    real column because RLS/tenancy needs it.
--
-- DEV-SPEC-V1 §1 HARD CONSTRAINTS enforced / documented here:
--  * ENCRYPTION — contact_handles.value_enc is application-layer encrypted
--    with AES-256-GCM using the exact blob format established by
--    canvas_connections.token_encrypted: "iv.ciphertext.authTag", three
--    base64 segments joined with '.' (see apps/api/src/lib/canvas.ts). The
--    spec asks for app-layer encryption of contact handles + canvas tokens;
--    the key lives in env, never in the database. Plaintext contact handles
--    must never be stored.
--  * NO PII IN LOGS — no schedule details, self-report values (energy /
--    sleep_h / mood), or contact info may ever appear in server logs or
--    analytics events. Column comments below restate this at the source.
--  * HARD DELETE — account deletion is a cascading hard delete: every
--    user-owned table here hangs off users(id) with on delete cascade, so
--    contact ciphertext dies with the account (PRODUCT-V1 §7.2/§7.5).
--
-- RLS model (house pattern: ALL writes go through the API service role,
-- which bypasses RLS — no client write policies anywhere):
--  * schools / terms / catalog_* — authenticated-read public reference data.
--  * plans / contact_handles     — owner-only SELECT.
--  * energy_reports / schedule_blocks — owner-only policies ALREADY exist
--    (20260707100000_scheduler_v0.sql); not recreated here.
--
-- Idempotent throughout: if not exists / on conflict do nothing / guarded
-- constraint replacement — safe to re-run.
-- ============================================================================

-- ------------------------------------------------------------------- schools
-- Tenant root (DEV-SPEC-V1 §1). edu_domains drives the magic-link whitelist
-- (POST /api/auth/magic-link suffix-matches against this, case-insensitive);
-- soc_adapter names the per-school course-catalog adapter (multi-school is
-- schema-ready per DEV-SPEC-V1 §12, Rutgers-only in V1).
create table if not exists schools (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  edu_domains text[] not null,
  campus_list jsonb not null default '[]'::jsonb,
  soc_adapter text not null default 'rutgers_soc',
  created_at timestamptz not null default now()
);

-- Seed: Rutgers New Brunswick. schools.name has no unique constraint, so the
-- guard is where-not-exists rather than on-conflict.
insert into schools (name, edu_domains, campus_list, soc_adapter)
select
  'Rutgers New Brunswick',
  array['rutgers.edu', 'scarletmail.rutgers.edu'],
  '["college_ave", "busch", "livingston", "cook_douglass"]'::jsonb,
  'rutgers_soc'
where not exists (
  select 1 from schools where name = 'Rutgers New Brunswick'
);

-- -------------------------------------------------------------- users tenancy
-- Nullable by design: legacy rows predate tenancy; the backfill below pins
-- every existing user to the Rutgers row. New signups get school_id from the
-- magic-link domain match.
alter table users
  add column if not exists school_id uuid references schools(id);

create index if not exists idx_users_school_id on users (school_id);

update users
   set school_id = (select id from schools where name = 'Rutgers New Brunswick')
 where school_id is null;

-- --------------------------------------------------------------------- terms
-- Academic terms per school ('fall26', ...). The cron SOC sync targets the
-- active term = the row whose starts_on..ends_on window covers today.
create table if not exists terms (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  code text not null,
  starts_on date not null,
  ends_on date not null,
  created_at timestamptz not null default now(),
  unique (school_id, code)
);

-- Seed: fall26 (semester anchor per the W1 pinned schema).
insert into terms (school_id, code, starts_on, ends_on)
select id, 'fall26', date '2026-09-01', date '2026-12-23'
  from schools
 where name = 'Rutgers New Brunswick'
on conflict (school_id, code) do nothing;

-- ----------------------------------------------------------- catalog_courses
-- SOC-adapter-written course catalog (spec `courses`; see the catalog_ prefix
-- adaptation note in the header — the live `courses` table is the untouched
-- user-import domain). Public reference data: no user rows, no PII.
create table if not exists catalog_courses (
  id uuid primary key default gen_random_uuid(),
  school_id uuid not null references schools(id) on delete cascade,
  term_id uuid not null references terms(id) on delete cascade,
  code text not null,
  title text,
  created_at timestamptz not null default now(),
  unique (school_id, term_id, code)
);

create index if not exists idx_catalog_courses_term_id
  on catalog_courses (term_id);

-- ---------------------------------------------------------- catalog_sections
-- Spec `sections`. index_no is the SOC section index (e.g. "10364");
-- is_open / last_seen_open_at feed Seat Watch diffing (W7).
create table if not exists catalog_sections (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references catalog_courses(id) on delete cascade,
  index_no text not null,
  campus text,
  instructor text,
  is_open boolean not null default false,
  last_seen_open_at timestamptz,
  created_at timestamptz not null default now(),
  unique (course_id, index_no)
);

-- openSections.json diffs look sections up by bare index_no.
create index if not exists idx_catalog_sections_index_no
  on catalog_sections (index_no);

-- --------------------------------------------------- catalog_section_meetings
-- Spec `section_meetings`. dow 1-7 (Mon=1), minutes-past-midnight times.
-- Times nullable: SOC lists asynchronous / by-arrangement sections without
-- meeting times. building/campus here are PUBLIC catalog facts about the
-- course, not user location — the §7.1 campus-granularity rule applies where
-- this data gets copied into a user's schedule (schedule_blocks.campus).
create table if not exists catalog_section_meetings (
  id uuid primary key default gen_random_uuid(),
  section_id uuid not null references catalog_sections(id) on delete cascade,
  dow int check (dow between 1 and 7),
  start_min int,
  end_min int,
  building text,
  campus text,
  created_at timestamptz not null default now()
);

create index if not exists idx_catalog_section_meetings_section_id
  on catalog_section_meetings (section_id);

-- --------------------------------------------------------------------- plans
-- One issued day-plan per user per day (DEV-SPEC-V1 §1). state tracks the
-- north-star funnel: issued -> viewed (daily plan engagement) -> replanned.
-- Schedule-adjacent data: owner-only RLS; per the header hard rule, plan
-- contents never appear in logs or analytics — only counts and booleans.
create table if not exists plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date date not null,
  capacity_pct int,
  state text not null default 'issued'
    check (state in ('issued', 'viewed', 'replanned')),
  generated_at timestamptz not null default now(),
  unique (user_id, date)
);

-- ------------------------------------- energy_reports = spec `checkins` (ext)
-- §7.5 HEALTH-ADJACENT (see 20260707100000_scheduler_v0.sql): the daily
-- checkin gains sleep hours and 1-5 mood. Same red lines as score: never in
-- logs, never in analytics, never visible to anyone but the owner.
alter table energy_reports add column if not exists sleep_h numeric;
alter table energy_reports add column if not exists mood int;

alter table energy_reports drop constraint if exists energy_reports_mood_check;
alter table energy_reports add constraint energy_reports_mood_check
  check (mood between 1 and 5);

comment on column energy_reports.sleep_h is
  'Self-reported sleep hours (health-adjacent, PRODUCT-V1 §7.5): owner-only; never in logs or analytics.';
comment on column energy_reports.mood is
  'Self-reported 1-5 mood (health-adjacent, PRODUCT-V1 §7.5): owner-only; never in logs or analytics.';

-- --------------------------------- schedule_blocks = spec `plan_blocks` (ext)
-- reason_effect joins the existing `reason` (spec reason_signal) to complete
-- the spec's reason pair; shed_reason records why protection mode dropped a
-- block (DEV-SPEC-V1 §3: shed blocks are marked, not deleted, so they can be
-- restored). The status check is REPLACED (guarded drop + add: Postgres has
-- no "add constraint if not exists") to admit 'shed'.
alter table schedule_blocks add column if not exists reason_effect text;
alter table schedule_blocks add column if not exists shed_reason text;

alter table schedule_blocks drop constraint if exists schedule_blocks_status_check;
alter table schedule_blocks add constraint schedule_blocks_status_check
  check (status in ('planned', 'done', 'missed', 'moved', 'shed'));

-- ------------------------------------------------------------ contact_handles
-- Most-sensitive PII in the product (PRODUCT-V1 §7.2). Handles are exchanged
-- only via the request->consent flow (W6), revocable, and hard-deleted with
-- the account (cascade).
create table if not exists contact_handles (
  user_id uuid not null references users(id) on delete cascade,
  kind text not null
    check (kind in ('wechat', 'qq', 'imessage', 'instagram', 'email')),
  -- ============================================================ LOUD WARNING
  -- value_enc is an AES-256-GCM blob — "iv.ciphertext.authTag", three base64
  -- segments joined with '.', the exact format of
  -- canvas_connections.token_encrypted (see apps/api/src/lib/canvas.ts).
  -- NEVER return value_enc raw to ANY client except through the
  -- owner-decrypted flow (W6): endpoints must enumerate columns and exclude
  -- it; never select('*') this table into anything a client can see. Never
  -- log it. Even as ciphertext it is treated as a secret.
  -- ==========================================================================
  value_enc text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, kind)
);

comment on table contact_handles is
  'Encrypted contact handles (PRODUCT-V1 §7.2, most-sensitive PII). Exchanged only via request->consent (W6); cascades away on account deletion.';
comment on column contact_handles.value_enc is
  'AES-256-GCM blob "iv.ciphertext.authTag" (base64 segments, apps/api/src/lib/canvas.ts format). NEVER return raw to any client except the owner-decrypted flow (W6); never log; never in analytics.';

-- ------------------------------------------------------------------------ RLS
alter table schools enable row level security;
alter table terms enable row level security;
alter table catalog_courses enable row level security;
alter table catalog_sections enable row level security;
alter table catalog_section_meetings enable row level security;
alter table plans enable row level security;
alter table contact_handles enable row level security;

-- Public reference data: any signed-in user can read; only the service role
-- writes (RLS bypass — no write policies by design).
drop policy if exists schools_authenticated_select on schools;
create policy schools_authenticated_select on schools
  for select to authenticated
  using (true);

drop policy if exists terms_authenticated_select on terms;
create policy terms_authenticated_select on terms
  for select to authenticated
  using (true);

drop policy if exists catalog_courses_authenticated_select on catalog_courses;
create policy catalog_courses_authenticated_select on catalog_courses
  for select to authenticated
  using (true);

drop policy if exists catalog_sections_authenticated_select on catalog_sections;
create policy catalog_sections_authenticated_select on catalog_sections
  for select to authenticated
  using (true);

drop policy if exists catalog_section_meetings_authenticated_select on catalog_section_meetings;
create policy catalog_section_meetings_authenticated_select on catalog_section_meetings
  for select to authenticated
  using (true);

-- Owner-only reads. energy_reports / schedule_blocks owner policies already
-- exist in 20260707100000_scheduler_v0.sql and are intentionally NOT
-- recreated here.
drop policy if exists plans_owner_select on plans;
create policy plans_owner_select on plans
  for select to authenticated
  using (auth.uid() = user_id);

-- Owner-only SELECT is safe despite value_enc being present: only the row's
-- owner can match (they already know their own handles), and API endpoints
-- never select value_enc back to clients anyway (see the loud warning above).
drop policy if exists contact_handles_owner_select on contact_handles;
create policy contact_handles_owner_select on contact_handles
  for select to authenticated
  using (auth.uid() = user_id);
