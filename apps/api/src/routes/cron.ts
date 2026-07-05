import { Hono } from 'hono'
import { supabase } from '../lib/supabase.js'
import { ensureDailyQuests, todayDateString } from '../lib/quests.js'

export const cronRoutes = new Hono()

/**
 * 6 AM daily quest generation (DEPLOY-FIXES §7).
 * Scheduled by Vercel Cron (apps/api/vercel.json). Vercel sends
 * `Authorization: Bearer $CRON_SECRET` automatically when the env var is set.
 */
cronRoutes.get('/daily-quests', async (c) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('authorization') || ''
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  const date = c.req.query('date') || todayDateString()
  let users = 0
  let created = 0
  let failed = 0

  // Page through users; fine at current scale (single school beta).
  const pageSize = 500
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('users')
      .select('id')
      .range(from, from + pageSize - 1)
    if (error) return c.json({ success: false, error: error.message }, 500)
    const batch = (data as { id: string }[]) || []
    if (batch.length === 0) break

    for (const u of batch) {
      users += 1
      try {
        const res = await ensureDailyQuests(u.id, date)
        created += res.created
      } catch (err) {
        failed += 1
        console.error(`daily-quests failed for ${u.id}:`, err)
      }
    }
    if (batch.length < pageSize) break
  }

  return c.json({ success: true, date, users, created, failed })
})
