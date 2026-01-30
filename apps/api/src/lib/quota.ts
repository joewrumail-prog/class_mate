import { supabase } from './supabase'

const DAILY_QUOTA = parseInt(process.env.DAILY_MATCH_QUOTA || '3')

const nextResetAt = () => {
  const now = new Date()
  const reset = new Date(now)
  reset.setUTCHours(24, 0, 0, 0)
  return reset.toISOString()
}

export async function consumeQuota(userId: string, isEdu: boolean) {
  if (isEdu) return

  const { data: user, error } = await supabase
    .from('users')
    .select('match_quota_remaining, match_quota_reset_at')
    .eq('id', userId)
    .single()

  if (error) throw error

  const now = new Date()
  const resetAt = user?.match_quota_reset_at ? new Date(user.match_quota_reset_at) : null
  let remaining = user?.match_quota_remaining ?? DAILY_QUOTA

  if (!resetAt || resetAt <= now) {
    remaining = DAILY_QUOTA
  }

  if (remaining <= 0) {
    throw new Error('Quota exceeded')
  }

  const nextRemaining = remaining - 1
  const { error: updateError } = await supabase
    .from('users')
    .update({ match_quota_remaining: nextRemaining, match_quota_reset_at: nextResetAt() })
    .eq('id', userId)

  if (updateError) throw updateError
}
