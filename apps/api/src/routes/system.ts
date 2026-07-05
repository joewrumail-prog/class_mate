import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import { levelFromXp, QUEST_XP } from '../lib/xp.js'
import { ensureCoreQuests, ensureDailyQuests, todayDateString } from '../lib/quests.js'
import type { AppVariables } from '../types.js'

export const systemRoutes = new Hono<{ Variables: AppVariables }>()

/** Total lifetime XP for a user (level is always computed from this). */
async function totalXp(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('user_xp_total', { p_user_id: userId })
  if (error) throw error
  return Number(data) || 0
}

async function weeklyXp(userId: string): Promise<number> {
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data, error } = await supabase
    .from('xp_events')
    .select('amount')
    .eq('user_id', userId)
    .gte('created_at', since)
  if (error) throw error
  return ((data as { amount: number }[]) || []).reduce((a, r) => a + r.amount, 0)
}

/** Consecutive days (ending today or yesterday) with at least one XP event. */
async function streakDays(userId: string): Promise<number> {
  const { data, error } = await supabase
    .from('xp_events')
    .select('created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(400)
  if (error) throw error

  const days = new Set(
    ((data as { created_at: string }[]) || []).map((r) => r.created_at.slice(0, 10))
  )
  let streak = 0
  const cursor = new Date()
  // A streak survives if there's activity today OR yesterday.
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1)
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

// ---------------------------------------------------------------- summary
systemRoutes.get('/summary', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const [xp, weekly, streak] = await Promise.all([
      totalXp(user.id),
      weeklyXp(user.id),
      streakDays(user.id),
    ])
    return c.json({ success: true, xp: levelFromXp(xp), weeklyXp: weekly, streak })
  } catch (error: any) {
    console.error('System summary error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ---------------------------------------------------------------- quests
systemRoutes.get('/quests', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const date = c.req.query('date') || todayDateString()

    // Lazy generation — the 6 AM cron usually did this already.
    await Promise.all([ensureDailyQuests(user.id, date), ensureCoreQuests(user.id)])

    const { data, error } = await supabase
      .from('quests')
      .select('*')
      .eq('user_id', user.id)
      .or(`quest_date.eq.${date},kind.in.(main,side)`)
      .order('created_at', { ascending: true })
    if (error) throw error

    const quests = (data as any[]) || []
    return c.json({
      success: true,
      date,
      daily: quests.filter((q) => q.kind === 'daily'),
      side: quests.filter((q) => q.kind === 'side'),
      main: quests.filter((q) => q.kind === 'main'),
    })
  } catch (error: any) {
    console.error('System quests error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ------------------------------------------------------ toggle a quest
// Acceptance (DEPLOY-FIXES §7): checking a quest writes an xp_events row and
// the header pill updates from the returned totals.
systemRoutes.post('/quests/:id/toggle', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const questId = c.req.param('id')

    const { data: quest, error: questError } = await supabase
      .from('quests')
      .select('*')
      .eq('id', questId)
      .eq('user_id', user.id)
      .single()
    if (questError || !quest) return c.json({ success: false, error: 'Quest not found' }, 404)

    const before = levelFromXp(await totalXp(user.id))
    const markingDone = !quest.done_at

    const { error: updateError } = await supabase
      .from('quests')
      .update({ done_at: markingDone ? new Date().toISOString() : null })
      .eq('id', questId)
    if (updateError) throw updateError

    if (markingDone) {
      const { error } = await supabase.from('xp_events').insert({
        user_id: user.id,
        amount: quest.xp,
        reason: `quest:${quest.title}`,
        quest_id: questId,
      })
      if (error) throw error
    } else {
      await supabase.from('xp_events').delete().eq('quest_id', questId).eq('user_id', user.id)
    }

    // All-clear bonus for daily quests
    let bonusApplied = false
    if (quest.kind === 'daily') {
      const date = quest.quest_date
      const { data: daily } = await supabase
        .from('quests')
        .select('id, done_at')
        .eq('user_id', user.id)
        .eq('kind', 'daily')
        .eq('quest_date', date)
      const all = ((daily as any[]) || [])
      const allDone = all.length > 0 && all.every((q) => q.done_at)
      const bonusReason = `daily-bonus:${date}`

      const { data: bonus } = await supabase
        .from('xp_events')
        .select('id')
        .eq('user_id', user.id)
        .eq('reason', bonusReason)
        .limit(1)

      if (allDone && (!bonus || bonus.length === 0)) {
        await supabase.from('xp_events').insert({
          user_id: user.id,
          amount: QUEST_XP.allClearBonus,
          reason: bonusReason,
        })
        bonusApplied = true
      } else if (!allDone && bonus && bonus.length > 0) {
        await supabase.from('xp_events').delete().eq('user_id', user.id).eq('reason', bonusReason)
      }
    }

    const after = levelFromXp(await totalXp(user.id))

    return c.json({
      success: true,
      done: markingDone,
      awardedXp: markingDone ? quest.xp : -quest.xp,
      bonusApplied,
      xp: after,
      leveledUp: after.level > before.level,
    })
  } catch (error: any) {
    console.error('Quest toggle error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ---------------------------------------------------------------- check-in
const checkinSchema = z.object({ kind: z.enum(['morning', 'evening']).default('evening') })

systemRoutes.post('/checkin', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const body = await c.req.json().catch(() => ({}))
    const { kind } = checkinSchema.parse(body)
    const date = todayDateString()
    const reason = `checkin:${kind}:${date}`

    const { data: existing } = await supabase
      .from('xp_events')
      .select('id')
      .eq('user_id', user.id)
      .eq('reason', reason)
      .limit(1)
    if (existing && existing.length > 0) {
      return c.json({ success: false, error: 'Already checked in' }, 409)
    }

    const { error } = await supabase.from('xp_events').insert({
      user_id: user.id,
      amount: QUEST_XP.eveningCheckin,
      reason,
    })
    if (error) throw error

    const after = levelFromXp(await totalXp(user.id))
    return c.json({ success: true, awardedXp: QUEST_XP.eveningCheckin, xp: after })
  } catch (error: any) {
    console.error('Check-in error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ---------------------------------------------------------------- study session
const sessionSchema = z.object({ roomId: z.string().uuid() })

systemRoutes.post('/session', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const { roomId } = sessionSchema.parse(await c.req.json())
    const date = todayDateString()
    const reason = `session:${roomId}:${date}`

    const { data: existing } = await supabase
      .from('xp_events')
      .select('id')
      .eq('user_id', user.id)
      .eq('reason', reason)
      .limit(1)
    if (existing && existing.length > 0) {
      return c.json({ success: false, error: 'Session already logged for this room today' }, 409)
    }

    const { error } = await supabase.from('xp_events').insert({
      user_id: user.id,
      amount: QUEST_XP.studySession,
      reason,
    })
    if (error) throw error

    const after = levelFromXp(await totalXp(user.id))
    return c.json({ success: true, awardedXp: QUEST_XP.studySession, xp: after })
  } catch (error: any) {
    console.error('Session error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ---------------------------------------------------------------- leaderboard
systemRoutes.get('/leaderboard', requireAuth, async (c) => {
  try {
    const user = c.get('user')

    const { data: myRooms } = await supabase
      .from('room_members')
      .select('room_id')
      .eq('user_id', user.id)
    const roomIds = ((myRooms as any[]) || []).map((r) => r.room_id)
    if (roomIds.length === 0) return c.json({ success: true, rows: [] })

    const { data: mates } = await supabase
      .from('room_members')
      .select('user_id, users(nickname)')
      .in('room_id', roomIds)
    const nameById = new Map<string, string>()
    for (const m of (mates as any[]) || []) {
      nameById.set(m.user_id, m.users?.nickname || 'Classmate')
    }
    nameById.set(user.id, 'You')

    const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
    const { data: events } = await supabase
      .from('xp_events')
      .select('user_id, amount')
      .in('user_id', Array.from(nameById.keys()))
      .gte('created_at', since)

    const sums = new Map<string, number>()
    for (const id of nameById.keys()) sums.set(id, 0)
    for (const e of (events as any[]) || []) {
      sums.set(e.user_id, (sums.get(e.user_id) || 0) + e.amount)
    }

    const rows = Array.from(sums.entries())
      .map(([id, xp]) => ({ id, name: nameById.get(id) || 'Classmate', xp, isMe: id === user.id }))
      .sort((a, b) => b.xp - a.xp)
      .slice(0, 10)
      .map((r, i) => ({ ...r, rank: i + 1 }))

    return c.json({ success: true, rows })
  } catch (error: any) {
    console.error('Leaderboard error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ---------------------------------------------------------------- settings
const settingsSchema = z.object({
  system_ui: z.boolean().optional(),
  school_id: z.string().max(30).nullable().optional(),
})

systemRoutes.post('/settings', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const patch = settingsSchema.parse(await c.req.json())

    const { data: row, error: readError } = await supabase
      .from('users')
      .select('settings')
      .eq('id', user.id)
      .single()
    if (readError) throw readError

    const settings = { ...((row as any)?.settings || {}), ...patch }
    const { error } = await supabase.from('users').update({ settings }).eq('id', user.id)
    if (error) throw error

    return c.json({ success: true, settings })
  } catch (error: any) {
    console.error('Settings error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})
