-- ============================================
-- Leveling data tables (LEVELING.md — data layer ONLY)
--  - seasons: one row per semester; exactly one active at a time
--  - season_campaigns: per-cohort content packs (quest_pack/title_pack are
--    seed COPY consumed by the engine; same engine + UI for every cohort,
--    only the content pack changes)
--  - xp_events.season_id: tags each XP row to the season it was earned in.
--    NULL season_id = career-layer-only rows (pre-season history written
--    before this migration, or grants that intentionally skip the season).
--
-- NOT in this migration (engine work staged behind this schema):
--  - Leveling curve stays in lib/xp.ts: XP to next level =
--    100 + 50 x (n - 1), capped at 500/level, hard cap L30 per season.
--  - Dual layer (season resets each semester, career layer never resets),
--    returning package (prev season >= L20: start L3, 2 streak freezes,
--    veteran ring, week-one double XP), transfer "Transferred In" career
--    badge, and daily/sponsored XP caps are all engine concerns.
--  - Transfer quest_pack below is the boosted belonging LAYER only; the
--    engine layers it on top of the user's academic-year cohort pack.
--  - Sponsored quests are allowed ONLY in the soph_junior pack (monetization
--    cohort) and NEVER in freshman (protect trust early); none are seeded
--    because no merchants are signed yet.
-- ============================================

CREATE TABLE IF NOT EXISTS public.seasons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  term_code TEXT NOT NULL UNIQUE,          -- e.g. '2026FA'
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Only one season may be active at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_seasons_one_active
  ON public.seasons(active) WHERE active;

CREATE TABLE IF NOT EXISTS public.season_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  season_id UUID NOT NULL REFERENCES public.seasons(id) ON DELETE CASCADE,
  cohort TEXT NOT NULL CHECK (cohort IN ('freshman', 'soph_junior', 'senior', 'transfer')),
  quest_pack JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{slug, title, xp, boosted?}]
  title_pack JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{level, title}]
  featured_module TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (season_id, cohort)
);

ALTER TABLE public.xp_events
  ADD COLUMN IF NOT EXISTS season_id UUID NULL REFERENCES public.seasons(id);
CREATE INDEX IF NOT EXISTS idx_xp_events_user_season
  ON public.xp_events(user_id, season_id);

-- RLS: campaign/season content is readable by any signed-in user; all writes
-- go through the API (service role bypasses RLS), so no write policies.
ALTER TABLE public.seasons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.season_campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authenticated read seasons" ON public.seasons;
CREATE POLICY "Authenticated read seasons" ON public.seasons
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Authenticated read season campaigns" ON public.season_campaigns;
CREATE POLICY "Authenticated read season campaigns" ON public.season_campaigns
  FOR SELECT TO authenticated USING (true);

-- ============================================
-- Seed: current season (Fall 2026) + its 4 cohort campaigns
-- ============================================

INSERT INTO public.seasons (term_code, starts_on, ends_on, active)
VALUES ('2026FA', '2026-09-01', '2026-12-23', true)
ON CONFLICT (term_code) DO NOTHING;

-- Shared milestone title pack (LEVELING.md): titles surface at 5/10/15/20/25/30.
INSERT INTO public.season_campaigns (season_id, cohort, quest_pack, title_pack, featured_module)
SELECT s.id, c.cohort, c.quest_pack, c.title_pack, c.featured_module
FROM public.seasons s
CROSS JOIN (
  VALUES
    -- Freshman (Y1) — goal: belonging. No sponsored quests.
    (
      'freshman',
      '[
        {"slug": "join-first-room", "title": "Join your first class Room", "xp": 20},
        {"slug": "join-all-rooms", "title": "Join a Room for every class", "xp": 40},
        {"slug": "first-study-session", "title": "Attend your first study session", "xp": 50},
        {"slug": "orientation-event", "title": "Check in at an orientation event", "xp": 30}
      ]'::jsonb,
      '[
        {"level": 5, "title": "Syllabus Survivor"},
        {"level": 10, "title": "Deadline Slayer"},
        {"level": 15, "title": "Lecture Hall Regular"},
        {"level": 20, "title": "Dean''s Radar"},
        {"level": 25, "title": "Campus Legend"},
        {"level": 30, "title": "The System"}
      ]'::jsonb,
      'rooms'
    ),
    -- Soph/Junior (Y2-3) — goal: GPA + internship. Side Quest "Internship
    -- hunt" is the spine; employer-sponsored quests land here once signed.
    (
      'soph_junior',
      '[
        {"slug": "internship-hunt", "title": "Side Quest: Internship hunt", "xp": 100},
        {"slug": "career-fair", "title": "Attend the career fair", "xp": 50},
        {"slug": "resume-review", "title": "Get a resume review", "xp": 40},
        {"slug": "application-count", "title": "Track 5 internship applications", "xp": 60}
      ]'::jsonb,
      '[
        {"level": 5, "title": "Syllabus Survivor"},
        {"level": 10, "title": "Deadline Slayer"},
        {"level": 15, "title": "Lecture Hall Regular"},
        {"level": 20, "title": "Dean''s Radar"},
        {"level": 25, "title": "Campus Legend"},
        {"level": 30, "title": "The System"}
      ]'::jsonb,
      NULL
    ),
    -- Senior (Y4) — goal: capstone + placement. Main Quest becomes thesis
    -- milestones; graduation countdown.
    (
      'senior',
      '[
        {"slug": "final-boss-capstone", "title": "Final Boss: Capstone", "xp": 100},
        {"slug": "thesis-milestone-proposal", "title": "Thesis milestone: proposal submitted", "xp": 60},
        {"slug": "thesis-milestone-draft", "title": "Thesis milestone: first full draft", "xp": 60},
        {"slug": "graduation-countdown", "title": "Graduation countdown check-in", "xp": 10}
      ]'::jsonb,
      '[
        {"level": 5, "title": "Syllabus Survivor"},
        {"level": 10, "title": "Deadline Slayer"},
        {"level": 15, "title": "Lecture Hall Regular"},
        {"level": 20, "title": "Dean''s Radar"},
        {"level": 25, "title": "Campus Legend"},
        {"level": 30, "title": "The System"}
      ]'::jsonb,
      NULL
    ),
    -- Transfer — hybrid: first-30-days belonging quests at boosted XP,
    -- layered on the academic-year pack by the engine. Day-one grants
    -- instead of a returning package (no prior season). Career layer gets
    -- the "Transferred In" badge (engine work, not seeded here).
    (
      'transfer',
      '[
        {"slug": "join-first-room", "title": "Join your first class Room", "xp": 30, "boosted": true},
        {"slug": "first-study-session", "title": "Attend your first study session", "xp": 75, "boosted": true},
        {"slug": "contact-exchange", "title": "Exchange contact with one classmate", "xp": 40, "boosted": true},
        {"slug": "day-one-import-schedule", "title": "Import your schedule", "xp": 80},
        {"slug": "day-one-connect-canvas", "title": "Connect Canvas", "xp": 50}
      ]'::jsonb,
      '[
        {"level": 5, "title": "Syllabus Survivor"},
        {"level": 10, "title": "Deadline Slayer"},
        {"level": 15, "title": "Lecture Hall Regular"},
        {"level": 20, "title": "Dean''s Radar"},
        {"level": 25, "title": "Campus Legend"},
        {"level": 30, "title": "The System"}
      ]'::jsonb,
      'rooms'
    )
) AS c(cohort, quest_pack, title_pack, featured_module)
WHERE s.term_code = '2026FA'
ON CONFLICT (season_id, cohort) DO NOTHING;
