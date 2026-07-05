-- ============================================
-- Grade data policy (NEXT-STEPS P0 #2)
--  - course_weights: one shared weight scheme per course room
--  - grade_goals: one user-set letter-grade target per (user, room)
-- ============================================
--
-- ╔══════════════════════════════════════════════════════════════════════╗
-- ║  GRADE DATA POLICY — READ BEFORE TOUCHING THIS SCHEMA                 ║
-- ║                                                                       ║
-- ║  GPA projection is computed CLIENT-SIDE. The server stores ONLY:      ║
-- ║    1. course weight schemes  (course_weights.components:              ║
-- ║       [{"name": "Final", "weight": 40}] — structure, not results)     ║
-- ║    2. user-set grade goals   (grade_goals.target_letter)              ║
-- ║                                                                       ║
-- ║  NO SCORE COLUMNS, EVER. No Canvas scores, no per-assignment grades,  ║
-- ║  no points earned / points possible, no computed percentages, no      ║
-- ║  current-grade snapshots. Scores live exclusively in localStorage on  ║
-- ║  the student's device (see apps/web/src/lib/gpa.ts).                  ║
-- ║                                                                       ║
-- ║  Why: storing grades is FERPA-adjacent liability, and "your grades    ║
-- ║  never leave your device" is a core trust selling point. Adding a     ║
-- ║  score column here is a product-policy violation, not a schema tweak. ║
-- ╚══════════════════════════════════════════════════════════════════════╝

-- 1. Course weight schemes (one per room; "one classmate confirming shares
--    it with the room" — README v2, Import → Syllabus tab)
CREATE TABLE IF NOT EXISTS public.course_weights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.course_rooms(id) ON DELETE CASCADE,
  -- [{ "name": "Homework", "weight": 30 }, ...] — component names + weights ONLY
  components JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(components) = 'array'),
  source TEXT NOT NULL CHECK (source IN ('syllabus', 'canvas', 'manual')),
  confirmed_by UUID REFERENCES public.users(id),
  shared BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (room_id)
);

-- 2. User grade goals (target letter only — never an actual grade)
CREATE TABLE IF NOT EXISTS public.grade_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  room_id UUID NOT NULL REFERENCES public.course_rooms(id) ON DELETE CASCADE,
  target_letter TEXT NOT NULL
    CHECK (target_letter IN ('A', 'A-', 'B+', 'B', 'B-', 'C+', 'C', 'D', 'F')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, room_id)
);

CREATE INDEX IF NOT EXISTS idx_grade_goals_user ON public.grade_goals(user_id);
CREATE INDEX IF NOT EXISTS idx_grade_goals_room ON public.grade_goals(room_id);

-- 3. updated_at triggers (function defined in 001_complete_schema.sql)
DROP TRIGGER IF EXISTS update_course_weights_updated_at ON public.course_weights;
CREATE TRIGGER update_course_weights_updated_at
  BEFORE UPDATE ON public.course_weights
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS update_grade_goals_updated_at ON public.grade_goals;
CREATE TRIGGER update_grade_goals_updated_at
  BEFORE UPDATE ON public.grade_goals
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- 4. RLS — all writes go through the API service role (bypasses RLS);
--    clients get read-only access, scoped as below.
ALTER TABLE public.course_weights ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grade_goals ENABLE ROW LEVEL SECURITY;

-- course_weights: readable by room members once shared, and always by the
-- classmate who confirmed the scheme.
DROP POLICY IF EXISTS "Room members read shared weights" ON public.course_weights;
CREATE POLICY "Room members read shared weights" ON public.course_weights
  FOR SELECT USING (
    confirmed_by = auth.uid()
    OR (
      shared = true
      AND EXISTS (
        SELECT 1
        FROM public.room_members rm
        WHERE rm.room_id = course_weights.room_id
          AND rm.user_id = auth.uid()
      )
    )
  );

-- grade_goals: owner-only. Goals are personal — never social, never shared
-- with the room (README v2: "Grades never social").
DROP POLICY IF EXISTS "Users read own grade goals" ON public.grade_goals;
CREATE POLICY "Users read own grade goals" ON public.grade_goals
  FOR SELECT USING (auth.uid() = user_id);

-- Service role full access (matches existing schema style; the API writes
-- with the service key, which bypasses RLS anyway)
DROP POLICY IF EXISTS "Service role full access course_weights" ON public.course_weights;
CREATE POLICY "Service role full access course_weights" ON public.course_weights
  FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role full access grade_goals" ON public.grade_goals;
CREATE POLICY "Service role full access grade_goals" ON public.grade_goals
  FOR ALL USING (auth.role() = 'service_role');
