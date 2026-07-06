import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import { isoDayOfWeek, todayDateString } from '../lib/quests.js'
import { getCurrentSemesterId } from '../lib/webreg.js'
import {
  applyProtectionMode,
  energyBudgetMinutes,
  fillSchedule,
  freeWindows,
  pressureScore,
  shouldReduceWeeklyFill,
} from '../lib/scheduler.js'
import type { EngineTask, Window } from '../lib/scheduler.js'
import {
  atlasBlockReason,
  atlasMorning,
  atlasProtection,
  maybeEasterEgg,
} from '../lib/atlas.js'
import type { AppVariables } from '../types.js'

/**
 * Scheduler routes — PRODUCT-V1 §3 (time × energy OS).
 *
 * The rule engine itself lives in lib/scheduler.ts (pure — the caller passes
 * nowMs); Atlas copy lives in lib/atlas.ts. This module is the IO glue:
 * energy self-reports, the day plan, plan generation (§3.2), commitments,
 * tasks, block actions, and the §3.4 morning cron dispatch.
 *
 * PRIVACY RED LINES (PRODUCT-V1 §7 — hard constraints):
 *  - Location is campus-level ONLY (schedule_blocks.campus). Never room-level
 *    in scheduler-owned data, and never visible to any other user: every
 *    query here is scoped to the authenticated owner.
 *  - Energy self-reports (energy_reports) are health-adjacent data. They are
 *    read and written exclusively inside this scheduling domain — no
 *    analytics, no Room, never surfaced to other users.
 *  - Canvas tokens are not handled here at all (see routes/canvas.ts); no
 *    endpoint in this file ever returns token material.
 */

export const schedulerRoutes = new Hono<{ Variables: AppVariables }>()

// =========================================================================
// Helpers — campus timezone math
// =========================================================================

function campusTz(): string {
  return process.env.CAMPUS_TZ || 'America/New_York'
}

/** Offset (ms) between the campus wall clock and UTC at a given instant. */
function tzOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value || '0')
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - utcMs
}

/** "YYYY-MM-DD" + "HH:MM" campus wall-clock time -> epoch ms (DST-safe). */
function zonedMs(date: string, hhmmStr: string): number {
  const [y, mo, d] = date.split('-').map(Number)
  const [h, mi] = hhmmStr.split(':').map(Number)
  const guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0)
  const offset = tzOffsetMs(guess, campusTz())
  let ts = guess - offset
  const check = tzOffsetMs(ts, campusTz())
  if (check !== offset) ts = guess - check
  return ts
}

/** Epoch ms -> "YYYY-MM-DD" in the campus timezone (plan_date semantics). */
function dateStringAt(ms: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: campusTz(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms))
}

function addDays(date: string, days: number): string {
  const [y, mo, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d + days, 12)).toISOString().slice(0, 10)
}

/** Normalize "H:MM" / "HH:MM:SS" (course_rooms.start_time et al) to "HH:MM". */
function hhmm(t: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ''))
  if (!m) return '00:00'
  return `${m[1].padStart(2, '0')}:${m[2]}`
}

function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/**
 * The wake window for a plan date. sleep_end is wake-up on `date`; a
 * sleep_start at/after midnight but before wake-up ("00:30") belongs to the
 * NEXT calendar day, while an evening bedtime ("23:00") is the same day.
 */
function wakeWindow(date: string, sleepStart: string, sleepEnd: string): Window {
  const startMs = zonedMs(date, sleepEnd)
  const endMs =
    hhmmToMinutes(sleepStart) <= hhmmToMinutes(sleepEnd)
      ? zonedMs(addDays(date, 1), sleepStart)
      : zonedMs(date, sleepStart)
  return { startMs, endMs }
}

/** ISO week key, e.g. "2026-W28" — commitment task source_ref suffix. */
function isoWeekKey(date: string): string {
  const d = new Date(`${date}T12:00:00Z`)
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const year = d.getUTCFullYear()
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** End of the ISO week containing `date` (Sunday 23:59 campus time), ISO. */
function endOfWeekIso(date: string): string {
  const sunday = addDays(date, 7 - isoDayOfWeek(date))
  return new Date(zonedMs(sunday, '23:59')).toISOString()
}

// =========================================================================
// Helpers — shared IO
// =========================================================================

interface UserSettings {
  sleep_start: string
  sleep_end: string
  home_campus: string
}

const SETTINGS_DEFAULTS: UserSettings = {
  // Documented defaults for users.settings (see pinned contracts).
  sleep_start: '00:30',
  sleep_end: '08:30',
  home_campus: 'college_ave',
}

async function loadSettings(userId: string): Promise<UserSettings> {
  const { data } = await supabase.from('users').select('settings').eq('id', userId).maybeSingle()
  const s = ((data as any)?.settings || {}) as Record<string, unknown>
  return {
    sleep_start: typeof s.sleep_start === 'string' ? s.sleep_start : SETTINGS_DEFAULTS.sleep_start,
    sleep_end: typeof s.sleep_end === 'string' ? s.sleep_end : SETTINGS_DEFAULTS.sleep_end,
    home_campus: typeof s.home_campus === 'string' ? s.home_campus : SETTINGS_DEFAULTS.home_campus,
  }
}

function toEngineTask(t: any): EngineTask {
  return {
    id: t.id,
    title: t.title,
    estimatedMinutes: t.estimated_minutes ?? 30,
    intensity: t.intensity ?? 3,
    dueAt: t.due_at ?? null,
    status: t.status as EngineTask['status'],
  }
}

function blockMinutes(b: { starts_at: string; ends_at: string }): number {
  return Math.max(0, Math.round((Date.parse(b.ends_at) - Date.parse(b.starts_at)) / 60_000))
}

/** Today's energy score for a user, or null when not reported. */
async function reportedScore(userId: string, date: string): Promise<number | null> {
  const { data } = await supabase
    .from('energy_reports')
    .select('score')
    .eq('user_id', userId)
    .eq('report_date', date)
    .maybeSingle()
  return (data as any)?.score ?? null
}

/**
 * Scores for the 3 calendar days ending at `date` (oldest first, null when
 * missing) — the input shape shouldReduceWeeklyFill expects.
 */
async function lastThreeScores(userId: string, date: string): Promise<(number | null)[]> {
  const days = [addDays(date, -2), addDays(date, -1), date]
  const { data } = await supabase
    .from('energy_reports')
    .select('report_date, score')
    .eq('user_id', userId)
    .in('report_date', days)
  const byDate = new Map(((data as any[]) || []).map((r) => [r.report_date, r.score]))
  return days.map((d) => byDate.get(d) ?? null)
}

// =========================================================================
// Helpers — plan generation (§3.2, shared by POST /plan/generate + cron)
// =========================================================================

/** Rutgers NB campuses (campus-level only — §7 red line). */
const CAMPUS_LABEL: Record<string, string> = {
  college_ave: 'College Ave',
  busch: 'Busch',
  livingston: 'Livingston',
  cook_douglass: 'Cook/Douglass',
}

const BUS_HEADWAY_SLACK_MIN = 10 // campus bus headway slack on top of the matrix
const DEFAULT_COMMUTE_MIN = 20 // when the campus pair is missing from the matrix
const NORMAL_FILL_CAP = 0.8 // §3.2: daily fill cap 80%, keep slack
const REDUCED_FILL_CAP = 0.6 // §3.3: 3 consecutive low self-reports -> back off

interface HardBlock {
  title: string
  kind: 'class' | 'commute'
  startMs: number
  endMs: number
  campus: string | null
}

async function commuteMatrix(): Promise<Map<string, number>> {
  const { data } = await supabase.from('campus_commute').select('*')
  const map = new Map<string, number>()
  for (const row of (data as any[]) || []) {
    map.set(`${row.campus_a}|${row.campus_b}`, row.minutes)
    map.set(`${row.campus_b}|${row.campus_a}`, row.minutes)
  }
  return map
}

/**
 * Generate the plan for one user + date. §3.2 order of operations:
 *   1. Hard constraints first — class blocks (course_rooms meetings for the
 *      weekday) + commute blocks between consecutive classes on different
 *      campuses (campus_commute matrix + bus-headway slack).
 *   2. Delete-and-rewrite ONLY future, non-locked, non-manual blocks for the
 *      date. Rescheduling never edits the past, user manual blocks, or
 *      user-moved (locked) blocks.
 *   3. Soft fill — fillSchedule places pending tasks into the remaining
 *      wake-window gaps within the energy budget and fill cap.
 */
async function generatePlanForUser(
  userId: string,
  date: string,
  nowMs: number
): Promise<{ created: number; blocks: any[] }> {
  const nowIso = new Date(nowMs).toISOString()
  const settings = await loadSettings(userId)
  const wake = wakeWindow(date, settings.sleep_start, settings.sleep_end)

  // ---- 1. hard constraints: class meetings for this weekday ------------
  const dow = isoDayOfWeek(date)
  const { data: memberships, error: memberError } = await supabase
    .from('room_members')
    .select('room_id, course_rooms!inner(*, courses(name))')
    .eq('user_id', userId)
    .eq('course_rooms.day_of_week', dow)
  if (memberError) throw memberError

  let meetings = ((memberships as any[]) || [])
    .map((m) => (Array.isArray(m.course_rooms) ? m.course_rooms[0] : m.course_rooms))
    .filter(Boolean)

  // Prefer current-semester rooms when the user has any; otherwise keep all
  // (stale-semester users still get a plan instead of an empty day).
  const semesterId = getCurrentSemesterId(new Date(nowMs))
  const current = meetings.filter((m) => m.semester_id === semesterId)
  if (current.length > 0) meetings = current

  const classBlocks: HardBlock[] = meetings
    .map((m) => ({
      title: m.courses?.name || 'Class',
      kind: 'class' as const,
      startMs: zonedMs(date, hhmm(m.start_time)),
      endMs: zonedMs(date, hhmm(m.end_time)),
      // §7: campus-level only. course_rooms.campus when the column exists,
      // else the user's home campus. classroom (room-level) is deliberately
      // NOT copied onto scheduler blocks.
      campus: (m.campus as string) || settings.home_campus,
    }))
    .filter((b) => b.endMs > b.startMs)
    .sort((a, b) => a.startMs - b.startMs)

  // Commute blocks between consecutive classes on different campuses.
  const commutes: HardBlock[] = []
  if (classBlocks.length > 1) {
    const matrix = await commuteMatrix()
    for (let i = 1; i < classBlocks.length; i++) {
      const prev = classBlocks[i - 1]
      const next = classBlocks[i]
      if (!prev.campus || !next.campus || prev.campus === next.campus) continue
      const minutes =
        (matrix.get(`${prev.campus}|${next.campus}`) ?? DEFAULT_COMMUTE_MIN) +
        BUS_HEADWAY_SLACK_MIN
      const endMs = next.startMs
      const startMs = Math.max(prev.endMs, endMs - minutes * 60_000)
      if (endMs <= startMs) continue
      commutes.push({
        title: `Bus · ${CAMPUS_LABEL[prev.campus] || prev.campus} → ${CAMPUS_LABEL[next.campus] || next.campus}`,
        kind: 'commute',
        startMs,
        endMs,
        campus: next.campus,
      })
    }
  }

  // ---- 2. delete-and-rewrite (future, non-locked, non-manual only) -----
  const { data: doomed, error: doomedError } = await supabase
    .from('schedule_blocks')
    .select('id, task_id')
    .eq('user_id', userId)
    .eq('plan_date', date)
    .eq('locked', false)
    .neq('kind', 'manual')
    .gt('starts_at', nowIso)
  if (doomedError) throw doomedError

  const doomedRows = (doomed as any[]) || []
  if (doomedRows.length > 0) {
    const { error: deleteError } = await supabase
      .from('schedule_blocks')
      .delete()
      .in('id', doomedRows.map((b) => b.id))
    if (deleteError) throw deleteError

    // Tasks whose blocks we just deleted go back to the pending pool so the
    // fill below can re-place them (and never double-schedules others).
    const taskIds = Array.from(new Set(doomedRows.map((b) => b.task_id).filter(Boolean)))
    if (taskIds.length > 0) {
      await supabase
        .from('tasks')
        .update({ status: 'pending' })
        .in('id', taskIds)
        .eq('user_id', userId)
        .eq('status', 'scheduled')
    }
  }

  // What survives (past blocks, locked/user-moved blocks, manual blocks,
  // protection markers) stays occupied — rewrites plan around it.
  const { data: remainingData, error: remainingError } = await supabase
    .from('schedule_blocks')
    .select('*')
    .eq('user_id', userId)
    .eq('plan_date', date)
  if (remainingError) throw remainingError
  const remaining = (remainingData as any[]) || []

  // Insert only future hard blocks (the past is never rewritten) and skip
  // any that survived deletion (e.g. a locked, user-moved class block).
  const remainingKeys = new Set(remaining.map((b) => `${b.kind}|${Date.parse(b.starts_at)}`))
  const hardInserts = [...classBlocks, ...commutes].filter(
    (b) => b.startMs > nowMs && !remainingKeys.has(`${b.kind}|${b.startMs}`)
  )

  // ---- 3. soft fill within the energy budget ----------------------------
  const occupied: Window[] = [
    ...remaining.map((b) => ({ startMs: Date.parse(b.starts_at), endMs: Date.parse(b.ends_at) })),
    ...hardInserts.map((b) => ({ startMs: b.startMs, endMs: b.endMs })),
  ]

  const classMinutesToday = classBlocks.reduce(
    (sum, b) => sum + Math.round((b.endMs - b.startMs) / 60_000),
    0
  )
  const selfReport = await reportedScore(userId, date)
  const budgetMinutes = energyBudgetMinutes({
    sleepStartHHMM: settings.sleep_start,
    sleepEndHHMM: settings.sleep_end,
    classMinutesToday,
    selfReport: selfReport as 1 | 2 | 3 | 4 | 5 | null,
  })

  // §3.3: three consecutive low self-reports reduce the weekly fill rate.
  const fillCap = shouldReduceWeeklyFill(await lastThreeScores(userId, date))
    ? REDUCED_FILL_CAP
    : NORMAL_FILL_CAP

  const { data: taskData, error: taskError } = await supabase
    .from('tasks')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
  if (taskError) throw taskError
  const taskRows = (taskData as any[]) || []
  const taskById = new Map(taskRows.map((t) => [t.id, toEngineTask(t)]))

  // Never plan into the past: today's window starts no earlier than now.
  const windowStart = Math.min(Math.max(wake.startMs, nowMs), wake.endMs)
  const windows = freeWindows(windowStart, wake.endMs, occupied)
  const planned = fillSchedule(
    windows,
    taskRows.map(toEngineTask),
    budgetMinutes,
    nowMs,
    { fillCap }
  ).slice()
  planned.sort((a, b) => a.startMs - b.startMs)

  let usedMinutes = 0
  const taskInserts = planned.map((p) => {
    const task = taskById.get(p.taskId)
    const reason = task
      ? atlasBlockReason(task, pressureScore(task, nowMs), Math.max(0, budgetMinutes - usedMinutes))
      : p.reason
    usedMinutes += Math.round((p.endMs - p.startMs) / 60_000)
    return {
      user_id: userId,
      task_id: p.taskId,
      title: p.title,
      kind: 'task',
      plan_date: date,
      starts_at: new Date(p.startMs).toISOString(),
      ends_at: new Date(p.endMs).toISOString(),
      campus: null,
      locked: false,
      status: 'planned',
      reason,
    }
  })

  const inserts = [
    ...hardInserts.map((b) => ({
      user_id: userId,
      task_id: null,
      title: b.title,
      kind: b.kind,
      plan_date: date,
      starts_at: new Date(b.startMs).toISOString(),
      ends_at: new Date(b.endMs).toISOString(),
      campus: b.campus,
      locked: false,
      status: 'planned',
      reason: null,
    })),
    ...taskInserts,
  ]

  if (inserts.length > 0) {
    const { error: insertError } = await supabase.from('schedule_blocks').insert(inserts)
    if (insertError) throw insertError
  }

  const placedTaskIds = Array.from(new Set(planned.map((p) => p.taskId)))
  if (placedTaskIds.length > 0) {
    await supabase
      .from('tasks')
      .update({ status: 'scheduled' })
      .in('id', placedTaskIds)
      .eq('user_id', userId)
      .eq('status', 'pending')
  }

  const { data: dayBlocks, error: dayError } = await supabase
    .from('schedule_blocks')
    .select('*')
    .eq('user_id', userId)
    .eq('plan_date', date)
    .order('starts_at', { ascending: true })
  if (dayError) throw dayError

  return { created: inserts.length, blocks: (dayBlocks as any[]) || [] }
}

// =========================================================================
// Helpers — error envelope (house style: zod -> 400, else 500)
// =========================================================================

function fail(c: Context, error: any, label: string) {
  if (error instanceof z.ZodError) {
    return c.json({ success: false, error: error.errors[0]?.message || 'Invalid input' }, 400)
  }
  console.error(`${label}:`, error)
  return c.json({ success: false, error: error.message }, 500)
}

// =========================================================================
// Routes — energy self-report (§3.3)
// =========================================================================

const energySchema = z.object({ score: z.number().int().min(1).max(5) })

schedulerRoutes.post('/energy', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const { score } = energySchema.parse(await c.req.json().catch(() => ({})))
    const date = todayDateString()
    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()

    // One report per day (unique user+date) — re-reporting overwrites.
    // §7: this row never leaves the scheduling domain.
    const { data: report, error: upsertError } = await supabase
      .from('energy_reports')
      .upsert({ user_id: user.id, report_date: date, score }, { onConflict: 'user_id,report_date' })
      .select('*')
      .single()
    if (upsertError) throw upsertError

    // Recompute today's budget with the fresh multiplier.
    const settings = await loadSettings(user.id)
    const { data: todayBlocksData, error: blocksError } = await supabase
      .from('schedule_blocks')
      .select('*')
      .eq('user_id', user.id)
      .eq('plan_date', date)
    if (blocksError) throw blocksError
    const todayBlocks = (todayBlocksData as any[]) || []

    const classMinutesToday = todayBlocks
      .filter((b) => b.kind === 'class')
      .reduce((sum, b) => sum + blockMinutes(b), 0)
    const budgetMinutes = energyBudgetMinutes({
      sleepStartHHMM: settings.sleep_start,
      sleepEndHHMM: settings.sleep_end,
      classMinutesToday,
      selfReport: score as 1 | 2 | 3 | 4 | 5,
    })

    // §3.3 protection mode: score <= 2 cuts today's low-priority load —
    // only tasks due within 48h keep their remaining planned blocks.
    let protection: { dropped: number; kept: number; advice: string } | null = null
    let atlas: string | null = null
    if (score <= 2) {
      const { data: plannedData, error: plannedError } = await supabase
        .from('schedule_blocks')
        .select('*, tasks(*)')
        .eq('user_id', user.id)
        .eq('plan_date', date)
        .eq('kind', 'task')
        .eq('status', 'planned')
        .eq('locked', false) // user-moved blocks always win (§3.2 trigger 4)
        .gt('starts_at', nowIso)
      if (plannedError) throw plannedError

      const plannedBlocks = ((plannedData as any[]) || []).filter((b) => b.tasks)
      const engineTasks = plannedBlocks.map((b) => toEngineTask(b.tasks))
      const result = applyProtectionMode(engineTasks, nowMs)
      const droppedIds = new Set(result.dropped.map((t) => t.id))
      const droppedBlocks = plannedBlocks.filter((b) => droppedIds.has(b.tasks.id))

      if (droppedBlocks.length > 0) {
        const { error: moveError } = await supabase
          .from('schedule_blocks')
          .update({ status: 'moved', reason: 'Protection mode — moved off today (energy low)' })
          .in('id', droppedBlocks.map((b) => b.id))
        if (moveError) throw moveError

        // Dropped tasks return to the pool; the next generate re-places them.
        await supabase
          .from('tasks')
          .update({ status: 'pending' })
          .in('id', Array.from(droppedIds))
          .eq('user_id', user.id)
          .eq('status', 'scheduled')
      }

      // Marker block: the rest of the wake window is protected recovery
      // time. Locked so a same-day regenerate never plans over it.
      const wake = wakeWindow(date, settings.sleep_start, settings.sleep_end)
      const markerStart = Math.max(nowMs, wake.startMs)
      const markerEnd = Math.max(wake.endMs, markerStart + 30 * 60_000)
      const { error: markerError } = await supabase.from('schedule_blocks').insert({
        user_id: user.id,
        task_id: null,
        title: 'Protection mode — recovery',
        kind: 'protected',
        plan_date: date,
        starts_at: new Date(markerStart).toISOString(),
        ends_at: new Date(markerEnd).toISOString(),
        campus: null,
        locked: true,
        status: 'planned',
        reason: result.advice,
      })
      if (markerError) throw markerError

      protection = { dropped: droppedBlocks.length, kept: result.kept.length, advice: result.advice }
      atlas = atlasProtection(droppedBlocks.length)
    }

    return c.json({ success: true, report, budgetMinutes, protection, atlas })
  } catch (error: any) {
    return fail(c, error, 'Energy report error')
  }
})

// =========================================================================
// Routes — today's plan (§3.4 morning main + sides)
// =========================================================================

schedulerRoutes.get('/plan/today', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const date = todayDateString()
    const nowMs = Date.now()

    const [settings, blocksResult, reportsResult, tasksResult] = await Promise.all([
      loadSettings(user.id),
      supabase
        .from('schedule_blocks')
        .select('*')
        .eq('user_id', user.id)
        .eq('plan_date', date)
        .order('starts_at', { ascending: true }),
      supabase
        .from('energy_reports')
        .select('report_date, score')
        .eq('user_id', user.id)
        .order('report_date', { ascending: false })
        .limit(7),
      supabase
        .from('tasks')
        .select('*')
        .eq('user_id', user.id)
        .in('status', ['pending', 'scheduled']),
    ])
    if (blocksResult.error) throw blocksResult.error
    if (reportsResult.error) throw reportsResult.error
    if (tasksResult.error) throw tasksResult.error

    const blocks = (blocksResult.data as any[]) || []
    const reports = (reportsResult.data as any[]) || []
    const reported = reports.find((r) => r.report_date === date)?.score ?? null

    const classMinutesToday = blocks
      .filter((b) => b.kind === 'class')
      .reduce((sum, b) => sum + blockMinutes(b), 0)
    const budgetMinutes = energyBudgetMinutes({
      sleepStartHHMM: settings.sleep_start,
      sleepEndHHMM: settings.sleep_end,
      classMinutesToday,
      selfReport: reported as 1 | 2 | 3 | 4 | 5 | null,
    })
    const spentMinutes = blocks
      .filter((b) => b.kind === 'task' && b.status === 'done')
      .reduce((sum, b) => sum + blockMinutes(b), 0)
    const budgetLeft = Math.max(0, budgetMinutes - spentMinutes)

    // Main + sides = open tasks ranked by pressure (scheduled ones included:
    // after the morning generate they ARE today's storyline).
    const ranked = ((tasksResult.data as any[]) || [])
      .map((t) => {
        const task = toEngineTask(t)
        return { task, pressure: pressureScore(task, nowMs) }
      })
      .sort((a, b) => b.pressure - a.pressure)

    const main = ranked[0] || null
    const sides = ranked.slice(1, 3).map((r) => r.task.title)

    let greeting = atlasMorning(main ? main.task.title : null, sides, budgetMinutes)
    const egg = maybeEasterEgg({
      nowMs,
      pressure: main?.pressure,
      // All of the last week's reports are 5s (require a real streak).
      allScoresFive: reports.length >= 3 && reports.every((r) => r.score === 5),
    })
    if (egg) greeting = `${greeting} ${egg}`

    const currentBest = main
      ? {
          taskId: main.task.id,
          title: main.task.title,
          pressure: main.pressure,
          reason: atlasBlockReason(main.task, main.pressure, budgetLeft),
        }
      : null

    return c.json({
      success: true,
      date,
      blocks,
      atlas: { greeting, currentBest },
      energy: { reported, budgetMinutes, spentMinutes },
    })
  } catch (error: any) {
    return fail(c, error, 'Plan today error')
  }
})

// =========================================================================
// Routes — plan generation (§3.2)
// =========================================================================

const generateSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .optional(),
})

schedulerRoutes.post('/plan/generate', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const body = generateSchema.parse(await c.req.json().catch(() => ({})))
    const date = body.date || todayDateString()

    const { created, blocks } = await generatePlanForUser(user.id, date, Date.now())
    return c.json({ success: true, created, blocks })
  } catch (error: any) {
    return fail(c, error, 'Plan generate error')
  }
})

// =========================================================================
// Routes — commitments (gym / club / work / long-term goals)
// =========================================================================

const commitmentCreateSchema = z.object({
  kind: z.enum(['gym', 'club', 'work', 'goal', 'custom']).default('custom'),
  title: z.string().min(1).max(120),
  frequency_per_week: z.number().int().min(1).max(14).default(1),
  duration_minutes: z.number().int().min(15).max(480).default(60),
  intensity: z.number().int().min(1).max(5).default(3),
  preferred_windows: z.array(z.any()).max(14).default([]),
  long_term_note: z.string().max(500).nullable().optional(),
})

const commitmentPatchSchema = z.object({
  kind: z.enum(['gym', 'club', 'work', 'goal', 'custom']).optional(),
  title: z.string().min(1).max(120).optional(),
  frequency_per_week: z.number().int().min(1).max(14).optional(),
  duration_minutes: z.number().int().min(15).max(480).optional(),
  intensity: z.number().int().min(1).max(5).optional(),
  preferred_windows: z.array(z.any()).max(14).optional(),
  long_term_note: z.string().max(500).nullable().optional(),
  active: z.boolean().optional(),
})

schedulerRoutes.get('/commitments', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const { data, error } = await supabase
      .from('commitments')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
    if (error) throw error
    return c.json({ success: true, commitments: (data as any[]) || [] })
  } catch (error: any) {
    return fail(c, error, 'Commitments list error')
  }
})

schedulerRoutes.post('/commitments', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const body = commitmentCreateSchema.parse(await c.req.json().catch(() => ({})))

    const { data: commitment, error: insertError } = await supabase
      .from('commitments')
      .insert({ user_id: user.id, ...body })
      .select('*')
      .single()
    if (insertError) throw insertError

    // Seed this week's task instances: source_ref = commitment id + ISO week
    // + slot index, matching the partial unique (user_id, source, source_ref)
    // so a re-created commitment (new id) never collides.
    const date = todayDateString()
    const weekKey = isoWeekKey(date)
    const dueAt = endOfWeekIso(date)
    const seeds = Array.from({ length: body.frequency_per_week }, (_, i) => ({
      user_id: user.id,
      source: 'commitment',
      source_ref: `${commitment.id}:${weekKey}:${i + 1}`,
      title: body.title,
      estimated_minutes: body.duration_minutes,
      intensity: body.intensity,
      due_at: dueAt,
      status: 'pending',
    }))
    const { data: tasks, error: seedError } = await supabase
      .from('tasks')
      .insert(seeds)
      .select('*')
    if (seedError) throw seedError

    return c.json({ success: true, commitment, tasks: (tasks as any[]) || [] })
  } catch (error: any) {
    return fail(c, error, 'Commitment create error')
  }
})

schedulerRoutes.patch('/commitments/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ success: false, error: 'Commitment not found' }, 404)
    }
    const patch = commitmentPatchSchema.parse(await c.req.json().catch(() => ({})))

    const { data: commitment, error } = await supabase
      .from('commitments')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('*')
      .maybeSingle()
    if (error) throw error
    if (!commitment) return c.json({ success: false, error: 'Commitment not found' }, 404)

    return c.json({ success: true, commitment })
  } catch (error: any) {
    return fail(c, error, 'Commitment update error')
  }
})

schedulerRoutes.delete('/commitments/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ success: false, error: 'Commitment not found' }, 404)
    }

    const { data: commitment, error: findError } = await supabase
      .from('commitments')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (findError) throw findError
    if (!commitment) return c.json({ success: false, error: 'Commitment not found' }, 404)

    // Drop its open task instances too (done history stays; schedule_blocks
    // task_id is ON DELETE SET NULL so past blocks survive untouched).
    await supabase
      .from('tasks')
      .delete()
      .eq('user_id', user.id)
      .eq('source', 'commitment')
      .like('source_ref', `${id}:%`)
      .in('status', ['pending', 'scheduled'])

    const { error } = await supabase.from('commitments').delete().eq('id', id).eq('user_id', user.id)
    if (error) throw error

    return c.json({ success: true })
  } catch (error: any) {
    return fail(c, error, 'Commitment delete error')
  }
})

// =========================================================================
// Routes — tasks
// =========================================================================

const TASK_STATUSES = ['pending', 'scheduled', 'done', 'dropped'] as const

const taskCreateSchema = z.object({
  title: z.string().min(1).max(200),
  estimated_minutes: z.number().int().min(5).max(600).default(30),
  intensity: z.number().int().min(1).max(5).default(3),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
})

const taskPatchSchema = z.object({
  status: z.enum(TASK_STATUSES).optional(),
  estimated_minutes: z.number().int().min(5).max(600).optional(),
  intensity: z.number().int().min(1).max(5).optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
})

schedulerRoutes.get('/tasks', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const status = c.req.query('status')
    if (status && !TASK_STATUSES.includes(status as any)) {
      return c.json({ success: false, error: 'Invalid status filter' }, 400)
    }

    let query = supabase.from('tasks').select('*').eq('user_id', user.id)
    if (status) query = query.eq('status', status)
    const { data, error } = await query.order('due_at', { ascending: true, nullsFirst: false })
    if (error) throw error

    return c.json({ success: true, tasks: (data as any[]) || [] })
  } catch (error: any) {
    return fail(c, error, 'Tasks list error')
  }
})

// Manual tasks only — canvas tasks come from the Canvas sync, commitment
// tasks from POST /commitments. source is forced server-side.
schedulerRoutes.post('/tasks', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const body = taskCreateSchema.parse(await c.req.json().catch(() => ({})))

    const { data: task, error } = await supabase
      .from('tasks')
      .insert({
        user_id: user.id,
        source: 'manual',
        source_ref: null,
        title: body.title,
        estimated_minutes: body.estimated_minutes,
        intensity: body.intensity,
        due_at: body.due_at ?? null,
        status: 'pending',
      })
      .select('*')
      .single()
    if (error) throw error

    return c.json({ success: true, task })
  } catch (error: any) {
    return fail(c, error, 'Task create error')
  }
})

schedulerRoutes.patch('/tasks/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ success: false, error: 'Task not found' }, 404)
    }
    const body = taskPatchSchema.parse(await c.req.json().catch(() => ({})))

    const patch: Record<string, unknown> = {}
    if (body.status !== undefined) {
      patch.status = body.status
      patch.completed_at = body.status === 'done' ? new Date().toISOString() : null
    }
    if (body.estimated_minutes !== undefined) patch.estimated_minutes = body.estimated_minutes
    if (body.intensity !== undefined) patch.intensity = body.intensity
    if (body.due_at !== undefined) patch.due_at = body.due_at
    if (Object.keys(patch).length === 0) {
      return c.json({ success: false, error: 'Nothing to update' }, 400)
    }

    const { data: task, error } = await supabase
      .from('tasks')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('*')
      .maybeSingle()
    if (error) throw error
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)

    return c.json({ success: true, task })
  } catch (error: any) {
    return fail(c, error, 'Task update error')
  }
})

schedulerRoutes.delete('/tasks/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ success: false, error: 'Task not found' }, 404)
    }

    const { data: task, error: findError } = await supabase
      .from('tasks')
      .select('id')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (findError) throw findError
    if (!task) return c.json({ success: false, error: 'Task not found' }, 404)

    // schedule_blocks.task_id is ON DELETE SET NULL — blocks survive.
    const { error } = await supabase.from('tasks').delete().eq('id', id).eq('user_id', user.id)
    if (error) throw error

    return c.json({ success: true })
  } catch (error: any) {
    return fail(c, error, 'Task delete error')
  }
})

// =========================================================================
// Routes — block actions (done / missed / move)
// =========================================================================

const blockPatchSchema = z
  .object({
    action: z.enum(['done', 'missed', 'move']),
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
  })
  .refine((v) => v.action !== 'move' || (v.startsAt && v.endsAt), {
    message: 'move requires startsAt and endsAt',
  })
  .refine(
    (v) => v.action !== 'move' || Date.parse(v.endsAt as string) > Date.parse(v.startsAt as string),
    { message: 'endsAt must be after startsAt' }
  )

schedulerRoutes.patch('/blocks/:id', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!z.string().uuid().safeParse(id).success) {
      return c.json({ success: false, error: 'Block not found' }, 404)
    }
    const body = blockPatchSchema.parse(await c.req.json().catch(() => ({})))

    const { data: block, error: findError } = await supabase
      .from('schedule_blocks')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (findError) throw findError
    if (!block) return c.json({ success: false, error: 'Block not found' }, 404)

    const patch: Record<string, unknown> = {}
    if (body.action === 'done') {
      patch.status = 'done'
      if (block.task_id) {
        await supabase
          .from('tasks')
          .update({ status: 'done', completed_at: new Date().toISOString() })
          .eq('id', block.task_id)
          .eq('user_id', user.id)
      }
    } else if (body.action === 'missed') {
      patch.status = 'missed'
      // §3.2 trigger 1 (task overran / not done): back to the pool so the
      // next generate re-places it.
      if (block.task_id) {
        await supabase
          .from('tasks')
          .update({ status: 'pending' })
          .eq('id', block.task_id)
          .eq('user_id', user.id)
          .eq('status', 'scheduled')
      }
    } else {
      // §3.2 trigger 4: a user drag wins forever — the block is locked and
      // no future regenerate will move or delete it.
      const startsMs = Date.parse(body.startsAt as string)
      patch.starts_at = new Date(startsMs).toISOString()
      patch.ends_at = new Date(Date.parse(body.endsAt as string)).toISOString()
      patch.plan_date = dateStringAt(startsMs)
      patch.locked = true
      patch.status = 'moved'
    }

    const { data: updated, error } = await supabase
      .from('schedule_blocks')
      .update(patch)
      .eq('id', id)
      .eq('user_id', user.id)
      .select('*')
      .single()
    if (error) throw error

    return c.json({ success: true, block: updated })
  } catch (error: any) {
    return fail(c, error, 'Block update error')
  }
})

// =========================================================================
// Routes — morning dispatch cron (§3.4)
// =========================================================================

// Same guard as routes/seatwatch.ts cronPoll: Vercel Cron sends
// `Authorization: Bearer $CRON_SECRET` when the env var is set. Vercel
// invokes cron paths with GET; POST is kept for manual/ops triggering.
// Wire in vercel.json: { "path": "/api/scheduler/cron/daily-plan",
// "schedule": "0 10 * * *" } (10:00 UTC = 6 AM ET).
const cronDailyPlan = async (c: Context) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('authorization') || ''
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  try {
    const date = todayDateString()
    const nowMs = Date.now()

    // Everyone with a schedule (course_rooms membership) or an active
    // commitment gets a fresh plan for today.
    const [membersResult, commitsResult] = await Promise.all([
      supabase.from('room_members').select('user_id'),
      supabase.from('commitments').select('user_id').eq('active', true),
    ])
    if (membersResult.error) throw membersResult.error
    if (commitsResult.error) throw commitsResult.error

    const userIds = Array.from(
      new Set(
        [
          ...(((membersResult.data as any[]) || []).map((r) => r.user_id) as string[]),
          ...(((commitsResult.data as any[]) || []).map((r) => r.user_id) as string[]),
        ].filter(Boolean)
      )
    )

    let planned = 0
    let errors = 0
    for (const userId of userIds) {
      try {
        await generatePlanForUser(userId, date, nowMs)
        planned += 1
      } catch (err) {
        console.error(`Daily plan failed for user ${userId}:`, err)
        errors += 1
      }
    }

    return c.json({ success: true, date, users: userIds.length, planned, errors })
  } catch (error: any) {
    console.error('Daily plan cron error:', error)
    return c.json({ success: false, error: error.message }, 500)
  }
}

schedulerRoutes.get('/cron/daily-plan', cronDailyPlan)
schedulerRoutes.post('/cron/daily-plan', cronDailyPlan)
