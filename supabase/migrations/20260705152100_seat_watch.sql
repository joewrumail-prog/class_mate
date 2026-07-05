-- Seat Watch (NEXT-STEPS P1 #5): watched sections, transition events,
-- WebReg adapter health (circuit breaker), and outage windows.
--
-- Writes happen exclusively through the API service role (bypasses RLS).
-- Clients get owner-scoped reads on watches/events and read-only visibility
-- into health/outages (the web app shows a "live seat data degraded" banner,
-- and the refund rule needs outage windows to be inspectable).

-- ------------------------------------------------------------- seat_watches
create table if not exists seat_watches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  section_index text not null,
  course_code text,
  -- Matches apps/web/src/lib/semester.ts getCurrentSemester().id, e.g. "2026-fall".
  semester text not null,
  status text not null default 'unknown' check (status in ('open', 'closed', 'unknown')),
  active boolean not null default true,
  last_checked_at timestamptz,
  -- Set on a closed->open transition. Push delivery wiring lands with P1 #7;
  -- this column is the alert ledger until then.
  notified_open_at timestamptz,
  created_at timestamptz not null default now(),
  unique (user_id, section_index, semester)
);

-- Poller reads oldest-checked active watches first.
create index if not exists idx_seat_watches_poll
  on seat_watches (last_checked_at asc nulls first)
  where active;

create index if not exists idx_seat_watches_user
  on seat_watches (user_id, semester);

-- -------------------------------------------------------- seat_watch_events
create table if not exists seat_watch_events (
  id uuid primary key default gen_random_uuid(),
  watch_id uuid not null references seat_watches(id) on delete cascade,
  kind text not null check (kind in ('open', 'closed', 'error', 'alert_sent')),
  at timestamptz not null default now()
);

create index if not exists idx_seat_watch_events_watch
  on seat_watch_events (watch_id, at desc);

-- ------------------------------------------------------------ webreg_health
-- Single-row health snapshot for the WebReg adapter's circuit breaker
-- (apps/api/src/lib/webreg.ts). Row id=1 is the only row.
create table if not exists webreg_health (
  id int primary key default 1 check (id = 1),
  state text not null default 'closed' check (state in ('closed', 'open', 'half_open')),
  consecutive_failures int not null default 0,
  last_ok_at timestamptz,
  -- Most recent transition to 'open' (the cooldown anchor for half-open probes).
  opened_at timestamptz,
  -- true => registrar has been unreachable for at least two full open-cooldown
  -- windows; the product stops promising live seat data and falls back to
  -- ICS-import-only flows until recovery.
  degraded_ics_only boolean not null default false,
  updated_at timestamptz not null default now()
);

insert into webreg_health (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------- seat_watch_outages
-- One row per breaker-open window (started when the breaker opens, ended on
-- recovery). Powers the refund rule: if an outage overlaps the add/drop
-- period, Seat Watch Unlimited buyers for that semester are owed a refund.
-- Billing reads these rows; nothing here refunds automatically.
create table if not exists seat_watch_outages (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null,
  ended_at timestamptz,
  note text
);

create index if not exists idx_seat_watch_outages_open
  on seat_watch_outages (started_at desc)
  where ended_at is null;

-- ---------------------------------------------------------------------- RLS
alter table seat_watches enable row level security;
alter table seat_watch_events enable row level security;
alter table webreg_health enable row level security;
alter table seat_watch_outages enable row level security;

-- Owner-only reads; all writes go through the API service role (bypasses RLS).
create policy seat_watches_owner_select on seat_watches
  for select to authenticated
  using (auth.uid() = user_id);

create policy seat_watch_events_owner_select on seat_watch_events
  for select to authenticated
  using (
    exists (
      select 1 from seat_watches w
      where w.id = seat_watch_events.watch_id
        and w.user_id = auth.uid()
    )
  );

-- Health and outage windows are app-wide, non-sensitive status data.
create policy webreg_health_authenticated_select on webreg_health
  for select to authenticated
  using (true);

create policy seat_watch_outages_authenticated_select on seat_watch_outages
  for select to authenticated
  using (true);
