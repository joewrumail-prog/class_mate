-- ============================================
-- Referral loop (NEXT-STEPS P1 #11 — copy Coursicle)
--  - referrals: one row per referred (new) user; qualified_at is set by the
--    API once the referred user imports a schedule (>= 1 room_members row)
--  - entitlements: shared contract table (owned by this migration) — per-user
--    per-semester feature unlocks, e.g. 'seat_watch_unlimited' at 3 qualified
--    referrals
--  - All writes go through the API (service role, bypasses RLS); clients can
--    only read what the SELECT policies allow. No INSERT/UPDATE/DELETE
--    policies on purpose.
-- ============================================

CREATE TABLE IF NOT EXISTS public.referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- One referrer per new user
  referred_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set when the referred user imports a schedule
  qualified_at TIMESTAMPTZ,
  CONSTRAINT referrals_not_self CHECK (referrer_id <> referred_id)
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON public.referrals(referrer_id);

-- Shared entitlements contract table.
-- Feature keys: 'seat_watch_unlimited' (referral reward, per semester).
-- semester matches apps/web/src/lib/semester.ts getCurrentSemester().id,
-- e.g. '2026-fall'.
CREATE TABLE IF NOT EXISTS public.entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  feature TEXT NOT NULL,
  semester TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, feature, semester)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_user ON public.entitlements(user_id);

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.entitlements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Referral visible to referrer and referred" ON public.referrals;
CREATE POLICY "Referral visible to referrer and referred" ON public.referrals
  FOR SELECT USING (auth.uid() = referrer_id OR auth.uid() = referred_id);

DROP POLICY IF EXISTS "Users view own entitlements" ON public.entitlements;
CREATE POLICY "Users view own entitlements" ON public.entitlements
  FOR SELECT USING (auth.uid() = user_id);
