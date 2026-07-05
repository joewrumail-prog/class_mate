import { supabase } from './supabase.js'
import { QUEST_XP } from './xp.js'

/**
 * Daily quest generation.
 *
 * Called by the 6 AM cron (apps/api/src/routes/cron.ts) for every user, and
 * lazily from GET /api/system/quests so a user always has quests even if the
 * cron hasn't fired yet (idempotent — generation is skipped when today's
 * daily quests already exist).
 *
 * Sources:
 *  - schedule: one attendance quest per class meeting today (room_members ×
 *    course_rooms where day_of_week = today)
 *  - system: static habit quests (check-in / review / gym / sleep)
 */

const STATIC_DAILY: { slug: string; title: string; xp: number }[] = [
  { slug: 'checkin', title: 'Morning check-in', xp: QUEST_XP.checkin },
  { slug: 'review', title: 'Review class notes · 25 min', xp: QUEST_XP.review },
  { slug: 'gym', title: 'Gym session · 45 min', xp: QUEST_XP.gym },
  { slug: 'sleep', title: 'Lights out before 12:30 AM', xp: QUEST_XP.sleep },
]

/** ISO day of week for a YYYY-MM-DD date string: 1 = Monday … 7 = Sunday. */
export function isoDayOfWeek(date: string): number {
  const d = new Date(`${date}T12:00:00Z`)
  const js = d.getUTCDay() // 0 = Sunday
  return js === 0 ? 7 : js
}

export function todayDateString(): string {
  // America/New_York — campus timezone for the current school set.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.CAMPUS_TZ || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(new Date())
}

export async function ensureDailyQuests(userId: string, date: string): Promise<{ created: number }> {
  const { data: existing, error: existingError } = await supabase
    .from('quests')
    .select('id')
    .eq('user_id', userId)
    .eq('kind', 'daily')
    .eq('quest_date', date)
    .limit(1)

  if (existingError) throw existingError
  if (existing && existing.length > 0) return { created: 0 }

  const dow = isoDayOfWeek(date)

  // Class meetings today → attendance quests
  const { data: memberships, error: memberError } = await supabase
    .from('room_members')
    .select('room_id, course_rooms!inner(id, day_of_week, start_time, end_time, course_id, courses(name))')
    .eq('user_id', userId)
    .eq('course_rooms.day_of_week', dow)

  if (memberError) throw memberError

  const rows: Record<string, unknown>[] = []

  for (const m of (memberships as any[]) || []) {
    const room = m.course_rooms
    if (!room) continue
    const courseName = room.courses?.name || 'class'
    const endTime = typeof room.end_time === 'string' ? room.end_time : '23:59'
    rows.push({
      user_id: userId,
      kind: 'daily',
      source: 'schedule',
      title: `Attend ${courseName} lecture`,
      xp: QUEST_XP.lecture,
      quest_date: date,
      due_at: `${date}T${endTime.length === 5 ? `${endTime}:00` : endTime}`,
      meta: { room_id: room.id, slug: 'lecture' },
    })
  }

  for (const q of STATIC_DAILY) {
    rows.push({
      user_id: userId,
      kind: 'daily',
      source: 'system',
      title: q.title,
      xp: q.xp,
      quest_date: date,
      due_at: null,
      meta: { slug: q.slug },
    })
  }

  const { error: insertError } = await supabase.from('quests').insert(rows)
  if (insertError) throw insertError

  return { created: rows.length }
}

/**
 * Core (main + side) quest seeding.
 *
 * Called lazily from GET /api/system/quests alongside ensureDailyQuests.
 * Idempotent — skipped as soon as the user has any main/side quest, so user
 * edits to these rows are never overwritten.
 *
 * Copy mirrors the design prototype; states seed fresh: the first main-quest
 * milestone is active, the rest locked, and side-quest progress starts at 0.
 */

const MAIN_MILESTONES: { label: string; state: 'done' | 'active' | 'locked'; detail?: string }[] = [
  { label: 'Foundations', state: 'active', detail: '0/4' },
  { label: 'Core CS', state: 'locked' },
  { label: 'Math', state: 'locked' },
  { label: 'Electives', state: 'locked' },
  { label: 'Capstone', state: 'locked' },
]

const STATIC_SIDE: {
  slug: string
  title: string
  xp: number
  subtitle?: string
  target?: number
}[] = [
  { slug: 'club', title: 'Robotics Club — officer track', xp: QUEST_XP.sideClub, target: 5 },
  { slug: 'internship', title: "Internship hunt — Summer '27", xp: QUEST_XP.sideInternship, target: 10 },
  { slug: 'cert', title: 'AWS Cloud Practitioner', xp: QUEST_XP.sideCert, subtitle: 'Study plan · exam Nov 20' },
]

export async function ensureCoreQuests(userId: string): Promise<{ created: number }> {
  const { data: existing, error: existingError } = await supabase
    .from('quests')
    .select('id')
    .eq('user_id', userId)
    .in('kind', ['main', 'side'])
    .limit(1)

  if (existingError) throw existingError
  if (existing && existing.length > 0) return { created: 0 }

  const rows: Record<string, unknown>[] = [
    {
      user_id: userId,
      kind: 'main',
      source: 'system',
      title: 'Main Quest — B.S. CS',
      xp: QUEST_XP.mainQuest,
      quest_date: null,
      due_at: null,
      meta: {
        slug: 'degree',
        milestones: MAIN_MILESTONES,
        progress: { current: 0, target: 120 },
      },
    },
  ]

  for (const q of STATIC_SIDE) {
    const meta: Record<string, unknown> = { slug: q.slug }
    if (q.subtitle) meta.subtitle = q.subtitle
    if (q.target) meta.progress = { current: 0, target: q.target }
    rows.push({
      user_id: userId,
      kind: 'side',
      source: 'system',
      title: q.title,
      xp: q.xp,
      quest_date: null,
      due_at: null,
      meta,
    })
  }

  const { error: insertError } = await supabase.from('quests').insert(rows)
  if (insertError) throw insertError

  return { created: rows.length }
}
