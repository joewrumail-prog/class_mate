ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS invite_code TEXT;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS match_quota_remaining INTEGER DEFAULT 3;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS match_quota_reset_at TIMESTAMP WITH TIME ZONE;
