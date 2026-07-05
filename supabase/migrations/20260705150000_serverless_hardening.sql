-- ============================================
-- Serverless hardening (DEPLOY-FIXES §2/§3/§5)
--  - RLS on semesters (was the only public table without it)
--  - user_quotas + increment_quota(): atomic daily OCR quota (replaces
--    in-memory quota.ts state, serverless-safe)
--  - rate_limits + check_rate_limit(): fixed-window rate limiting (replaces
--    in-memory rateLimit.ts buckets)
--  - private `schedules` storage bucket + per-user folder policies for the
--    direct-upload OCR flow
-- ============================================

-- 1. semesters RLS
ALTER TABLE public.semesters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Anyone can view semesters" ON public.semesters;
CREATE POLICY "Anyone can view semesters" ON public.semesters
  FOR SELECT USING (true);

-- 2. Daily quota
CREATE TABLE IF NOT EXISTS public.user_quotas (
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  day DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  used INT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Users can view own quota" ON public.user_quotas;
CREATE POLICY "Users can view own quota" ON public.user_quotas
  FOR SELECT USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION public.increment_quota(p_user_id UUID, p_cost INT, p_limit INT)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day DATE := (now() AT TIME ZONE 'utc')::date;
  v_used INT;
BEGIN
  INSERT INTO public.user_quotas (user_id, day, used)
  VALUES (p_user_id, v_day, 0)
  ON CONFLICT (user_id, day) DO NOTHING;

  UPDATE public.user_quotas
     SET used = used + p_cost
   WHERE user_id = p_user_id
     AND day = v_day
     AND used + p_cost <= p_limit
  RETURNING used INTO v_used;

  IF v_used IS NULL THEN
    RETURN -1;  -- over limit
  END IF;
  RETURN p_limit - v_used;  -- remaining
END;
$$;
REVOKE EXECUTE ON FUNCTION public.increment_quota(UUID, INT, INT) FROM PUBLIC, anon, authenticated;

-- 3. Rate limiting
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INT NOT NULL DEFAULT 0
);
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.check_rate_limit(p_key TEXT, p_max INT, p_window_seconds INT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_count INT;
BEGIN
  INSERT INTO public.rate_limits (key, window_start, count)
  VALUES (p_key, v_now, 1)
  ON CONFLICT (key) DO UPDATE
    SET count = CASE
          WHEN rate_limits.window_start < v_now - make_interval(secs => p_window_seconds)
          THEN 1 ELSE rate_limits.count + 1 END,
        window_start = CASE
          WHEN rate_limits.window_start < v_now - make_interval(secs => p_window_seconds)
          THEN v_now ELSE rate_limits.window_start END
  RETURNING count INTO v_count;

  RETURN v_count <= p_max;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.check_rate_limit(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;

-- 4. Private storage bucket for schedule uploads (client uploads directly;
--    the API downloads with the service role and runs OCR)
INSERT INTO storage.buckets (id, name, public)
VALUES ('schedules', 'schedules', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Users upload own schedule files" ON storage.objects;
CREATE POLICY "Users upload own schedule files" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'schedules' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Users read own schedule files" ON storage.objects;
CREATE POLICY "Users read own schedule files" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'schedules' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Users delete own schedule files" ON storage.objects;
CREATE POLICY "Users delete own schedule files" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'schedules' AND (storage.foldername(name))[1] = auth.uid()::text);
