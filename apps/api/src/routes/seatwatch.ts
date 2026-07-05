import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import {
  getCurrentSemesterId,
  getOpenOutage,
  loadHealth,
  parseSemesterId,
  pollWatches,
} from '../lib/webreg.js'
import type { AppVariables } from '../types.js'

export const seatwatchRoutes = new Hono<{ Variables: AppVariables }>()

/** Free plan slot count; Seat Watch Unlimited lifts it (entitlements table). */
const FREE_SLOTS = 2

const createSchema = z.object({
  sectionIndex: z.string().regex(/^\d{1,6}$/, 'sectionIndex must be a Rutgers section index'),
  courseCode: z.string().max(40).optional(),
  semester: z
    .string()
    .regex(/^\d{4}-(spring|summer|fall|winter)$/)
    .optional(),
})

/**
 * True when the user holds the seat_watch_unlimited entitlement for the
 * semester. The entitlements table is owned by the referral feature (shared
 * contract: user_id, feature, semester, source); treat any read failure as
 * "not entitled" so seat watch degrades to the free tier, never to a 500.
 */
async function hasUnlimited(userId: string, semester: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('entitlements')
      .select('id')
      .eq('user_id', userId)
      .eq('feature', 'seat_watch_unlimited')
      .eq('semester', semester)
      .limit(1)
    if (error) return false
    return !!(data && data.length > 0)
  } catch {
    return false
  }
}

/** Public shape of webreg_health + the current outage window, if any. */
async function healthSnapshot() {
  const [health, outage] = await Promise.all([loadHealth(), getOpenOutage()])
  return {
    state: health.breaker.state,
    degradedIcsOnly: health.degradedIcsOnly,
    consecutiveFailures: health.breaker.consecutiveFailures,
    lastOkAt: health.lastOkAt,
    outageSince: outage?.started_at || null,
  }
}

// ------------------------------------------------------------ my watches
seatwatchRoutes.get('/', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const semester = c.req.query('semester') || getCurrentSemesterId()

    const { data, error } = await supabase
      .from('seat_watches')
      .select('*')
      .eq('user_id', user.id)
      .eq('semester', semester)
      .order('created_at', { ascending: false })
    if (error) throw error

    const watches = (data as any[]) || []
    const unlimited = await hasUnlimited(user.id, semester)

    return c.json({
      success: true,
      semester,
      watches,
      slots: {
        used: watches.filter((w) => w.active).length,
        limit: unlimited ? null : FREE_SLOTS,
        unlimited,
      },
      health: await healthSnapshot(),
    })
  } catch (error: any) {
    console.error('Seat watch list error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ------------------------------------------------------------ add a watch
seatwatchRoutes.post('/', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const body = createSchema.parse(await c.req.json())
    const semester = body.semester || getCurrentSemesterId()

    // Idempotent on (user, section, semester): re-adding an active watch is a
    // no-op; re-adding an inactive one reactivates it (still costs a slot).
    const { data: existing, error: existingError } = await supabase
      .from('seat_watches')
      .select('*')
      .eq('user_id', user.id)
      .eq('section_index', body.sectionIndex)
      .eq('semester', semester)
      .maybeSingle()
    if (existingError) throw existingError

    if (existing && existing.active) {
      return c.json({ success: true, watch: existing, created: false })
    }

    const { data: activeRows, error: countError } = await supabase
      .from('seat_watches')
      .select('id')
      .eq('user_id', user.id)
      .eq('semester', semester)
      .eq('active', true)
    if (countError) throw countError

    const activeCount = (activeRows || []).length
    const unlimited = await hasUnlimited(user.id, semester)
    if (!unlimited && activeCount >= FREE_SLOTS) {
      return c.json(
        {
          success: false,
          error: `Free plan is limited to ${FREE_SLOTS} seat watches per semester`,
          code: 'SLOT_LIMIT',
          upgrade: 'seat_watch_unlimited',
        },
        403
      )
    }

    if (existing) {
      const { data: revived, error: reviveError } = await supabase
        .from('seat_watches')
        .update({
          active: true,
          status: 'unknown',
          notified_open_at: null,
          course_code: body.courseCode || existing.course_code,
        })
        .eq('id', existing.id)
        .select('*')
        .single()
      if (reviveError) throw reviveError
      return c.json({ success: true, watch: revived, created: false })
    }

    // Best-effort course code from the synced SOC catalog when not provided.
    let courseCode = body.courseCode || null
    if (!courseCode) {
      const parsed = parseSemesterId(semester)
      if (parsed) {
        const { data: course } = await supabase
          .from('rutgers_courses')
          .select('course_string')
          .eq('index', body.sectionIndex)
          .eq('year', parsed.year)
          .eq('term', parsed.term)
          .maybeSingle()
        courseCode = course?.course_string || null
      }
    }

    const { data: watch, error: insertError } = await supabase
      .from('seat_watches')
      .insert({
        user_id: user.id,
        section_index: body.sectionIndex,
        course_code: courseCode,
        semester,
        status: 'unknown',
        active: true,
      })
      .select('*')
      .single()
    if (insertError) throw insertError

    return c.json({ success: true, watch, created: true })
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return c.json({ success: false, error: error.errors[0]?.message || 'Invalid input' }, 400)
    }
    console.error('Seat watch create error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ------------------------------------------------------- public health snapshot
// Registered before /:id-style handlers for clarity; used by the web app for
// the "live seat data degraded — ICS-only mode" banner. No auth on purpose.
seatwatchRoutes.get('/health', async (c) => {
  try {
    return c.json({ success: true, health: await healthSnapshot() })
  } catch (error: any) {
    console.error('Seat watch health error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ------------------------------------------------------------ remove (soft)
seatwatchRoutes.delete('/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ success: false, error: 'Watch not found' }, 404)
    }

    const { data: watch, error: findError } = await supabase
      .from('seat_watches')
      .select('id, active')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (findError) throw findError
    if (!watch) {
      return c.json({ success: false, error: 'Watch not found' }, 404)
    }

    const { error } = await supabase
      .from('seat_watches')
      .update({ active: false })
      .eq('id', id)
      .eq('user_id', user.id)
    if (error) throw error

    return c.json({ success: true })
  } catch (error: any) {
    console.error('Seat watch delete error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
})

// ---------------------------------------------------------------- cron poll
// Same guard as routes/cron.ts: Vercel Cron sends `Authorization: Bearer
// $CRON_SECRET` automatically when the env var is set. Vercel invokes cron
// paths with GET, so the handler is registered for both GET and POST (POST
// kept for manual/ops triggering).
const cronPoll = async (c: Context) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('authorization') || ''
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const result = await pollWatches()
    return c.json({ success: true, ...result })
  } catch (error: any) {
    console.error('Seat watch poll error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
}

seatwatchRoutes.post('/cron/poll', cronPoll)
seatwatchRoutes.get('/cron/poll', cronPoll)
