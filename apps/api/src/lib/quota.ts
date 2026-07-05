import { supabase } from './supabase.js'

const DAILY_QUOTA = parseInt(process.env.DAILY_MATCH_QUOTA || '3')

/**
 * Consume one unit of the user's daily OCR/import quota.
 *
 * Serverless-safe: the counter lives in Postgres (`user_quotas` table) and is
 * incremented atomically by the `increment_quota` RPC, so it is consistent
 * across function instances. Throws 'Quota exceeded' when the daily limit is
 * reached. Edu-verified users are exempt.
 */
export async function consumeQuota(userId: string, isEdu: boolean) {
  if (isEdu) return

  const { data, error } = await supabase.rpc('increment_quota', {
    p_user_id: userId,
    p_cost: 1,
    p_limit: DAILY_QUOTA,
  })

  if (error) throw error

  // RPC returns remaining quota after consumption, or -1 when over limit.
  if (typeof data === 'number' && data < 0) {
    throw new Error('Quota exceeded')
  }
}
