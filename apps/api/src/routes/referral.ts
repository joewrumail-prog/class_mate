import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import type { AppVariables } from '../types.js'

export const referralRoutes = new Hono<{ Variables: AppVariables }>()

const SEAT_WATCH_FEATURE = 'seat_watch_unlimited'
const REQUIRED_QUALIFIED = 3
/** Anti-abuse: only accounts younger than this can redeem a referral code. */
const MAX_ACCOUNT_AGE_DAYS = 14

/**
 * Current semester id — mirrors apps/web/src/lib/semester.ts
 * getCurrentSemester().id (e.g. "2026-fall").
 * Jan–May: spring · Jun–Jul: summer · Aug–Dec: fall.
 */
function currentSemesterId(): string {
  const now = new Date()
  const month = now.getMonth() // 0-indexed
  const termName = month <= 4 ? 'spring' : month <= 6 ? 'summer' : 'fall'
  return `${now.getFullYear()}-${termName}`
}

/** Unambiguous uppercase alphabet — codes get pasted into chats and typed by hand. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

function generateInviteCode(length = 8): string {
  let code = ''
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
  }
  return code
}

/** Get (or lazily mint) the user's shareable invite code. */
async function ensureInviteCode(userId: string): Promise<string> {
  const { data: row, error } = await supabase
    .from('users')
    .select('invite_code')
    .eq('id', userId)
    .single()
  if (error) throw error
  if (row?.invite_code) return row.invite_code as string

  // users.invite_code has no unique constraint — check for the
  // (astronomically unlikely) collision and retry a few times.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateInviteCode()
    const { data: clash } = await supabase
      .from('users')
      .select('id')
      .eq('invite_code', code)
      .limit(1)
    if (clash && clash.length > 0) continue

    const { error: updateError } = await supabase
      .from('users')
      .update({ invite_code: code })
      .eq('id', userId)
    if (updateError) throw updateError
    return code
  }
  throw new Error('Could not generate an invite code')
}

// ---------------------------------------------------------------- redeem
const redeemSchema = z.object({ code: z.string().trim().min(1).max(50) })

referralRoutes.post('/redeem', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const { code } = redeemSchema.parse(await c.req.json())

    // Anti-abuse: only new accounts can be referred.
    const { data: me, error: meError } = await supabase
      .from('users')
      .select('id, created_at')
      .eq('id', user.id)
      .single()
    if (meError || !me) return c.json({ success: false, error: 'Profile not found' }, 404)

    const ageMs = Date.now() - new Date((me as any).created_at).getTime()
    if (ageMs > MAX_ACCOUNT_AGE_DAYS * 86_400_000) {
      return c.json(
        { success: false, error: 'Referral codes can only be redeemed within 14 days of signing up' },
        403
      )
    }

    // One referrer per new user (unique referred_id).
    const { data: existing } = await supabase
      .from('referrals')
      .select('id')
      .eq('referred_id', user.id)
      .limit(1)
    if (existing && existing.length > 0) {
      return c.json({ success: false, error: 'You have already redeemed a referral code' }, 409)
    }

    // users.invite_code has no unique constraint (it also stores the legacy
    // access-gate code, which several users may share) — treat any ambiguous
    // code as invalid instead of crediting an arbitrary matching user.
    const { data: owners, error: ownerError } = await supabase
      .from('users')
      .select('id')
      .eq('invite_code', code)
      .limit(2)
    if (ownerError) throw ownerError
    if (!owners || owners.length !== 1) {
      return c.json({ success: false, error: 'Invalid referral code' }, 404)
    }
    const referrer = owners[0] as { id: string }
    if (referrer.id === user.id) {
      return c.json({ success: false, error: 'You cannot refer yourself' }, 400)
    }

    const { error: insertError } = await supabase.from('referrals').insert({
      referrer_id: referrer.id,
      referred_id: user.id,
    })
    if (insertError) {
      // 23505 unique_violation — raced with another redeem for this user.
      if ((insertError as any).code === '23505') {
        return c.json({ success: false, error: 'You have already redeemed a referral code' }, 409)
      }
      throw insertError
    }

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Referral redeem error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ---------------------------------------------------------------- status
referralRoutes.get('/status', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const code = await ensureInviteCode(user.id)

    const { data: refRows, error: refError } = await supabase
      .from('referrals')
      .select('id, referred_id, created_at, qualified_at')
      .eq('referrer_id', user.id)
      .order('created_at', { ascending: true })
    if (refError) throw refError
    const referrals = (refRows as any[]) || []

    // Recompute qualification inline: a referral qualifies once the referred
    // user has imported a schedule (>= 1 room_members row).
    const pending = referrals.filter((r) => !r.qualified_at)
    if (pending.length > 0) {
      const { data: memberRows, error: memberError } = await supabase
        .from('room_members')
        .select('user_id')
        .in('user_id', pending.map((r) => r.referred_id))
      if (memberError) throw memberError
      const imported = new Set(((memberRows as any[]) || []).map((m) => m.user_id))

      const newlyQualified = pending.filter((r) => imported.has(r.referred_id))
      if (newlyQualified.length > 0) {
        const now = new Date().toISOString()
        const { error: updateError } = await supabase
          .from('referrals')
          .update({ qualified_at: now })
          .in('id', newlyQualified.map((r) => r.id))
        if (updateError) throw updateError
        for (const r of newlyQualified) r.qualified_at = now
      }
    }

    // Nicknames for the referral list
    const nameById = new Map<string, string>()
    if (referrals.length > 0) {
      const { data: mates } = await supabase
        .from('users')
        .select('id, nickname')
        .in('id', referrals.map((r) => r.referred_id))
      for (const m of (mates as any[]) || []) nameById.set(m.id, m.nickname || 'Classmate')
    }

    const qualifiedCount = referrals.filter((r) => r.qualified_at).length
    const semester = currentSemesterId()

    const { data: entRows, error: entError } = await supabase
      .from('entitlements')
      .select('id')
      .eq('user_id', user.id)
      .eq('feature', SEAT_WATCH_FEATURE)
      .eq('semester', semester)
      .limit(1)
    if (entError) throw entError

    let unlocked = !!(entRows && entRows.length > 0)
    let justUnlocked = false
    if (!unlocked && qualifiedCount >= REQUIRED_QUALIFIED) {
      const { error: grantError } = await supabase.from('entitlements').insert({
        user_id: user.id,
        feature: SEAT_WATCH_FEATURE,
        semester,
        source: 'referral',
      })
      if (grantError) {
        // 23505 — raced with a concurrent /status call; entitlement exists.
        if ((grantError as any).code !== '23505') throw grantError
      } else {
        justUnlocked = true
      }
      unlocked = true
    }

    return c.json({
      success: true,
      code,
      semester,
      required: REQUIRED_QUALIFIED,
      qualifiedCount,
      referrals: referrals.map((r) => ({
        id: r.id,
        nickname: nameById.get(r.referred_id) || 'Classmate',
        createdAt: r.created_at,
        qualified: !!r.qualified_at,
      })),
      unlocked,
      justUnlocked,
    })
  } catch (error: any) {
    console.error('Referral status error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})
