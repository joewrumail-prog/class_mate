/**
 * Scheduling rules engine v0 — PRODUCT-V1 §3.2 (scheduling algorithm) and
 * §3.3 (energy model). No ML: hard constraints occupy first (classes +
 * commute), soft constraints fill the gaps against an energy budget.
 *
 * File layout:
 *   1. PURE only — this entire module is the PURE section. No env access, no
 *      supabase import, no network, no Date.now(): every time-dependent
 *      function takes `nowMs` (epoch ms) from the caller.
 *      apps/api/tests/scheduler.test.ts imports this file with zero setup.
 *
 * Privacy (PRODUCT-V1 §7 — hard red lines):
 *   - Occupied windows fed into freeWindows() may be derived from commute
 *     buffers between campuses. Location is CAMPUS-LEVEL ONLY, never
 *     room-level, and exists solely to schedule the user's own day — it is
 *     never visible to other users and never appears in Room.
 *   - Energy self-reports (`selfReport`, `lastScores`) are health-adjacent
 *     data. They live inside this scheduling domain only: no analytics
 *     platform, no Room, no other users, ever.
 */

// =========================================================================
// Types (pinned engine contract)
// =========================================================================

export type EngineTaskStatus = 'pending' | 'scheduled' | 'done' | 'dropped'

/** Scheduler-facing view of a `tasks` row. */
export interface EngineTask {
  id: string
  title: string
  /** Minutes the task is expected to take (tasks.estimated_minutes). */
  estimatedMinutes: number
  /** 1 (light) .. 5 (heavy) — tasks.intensity. */
  intensity: number
  /** ISO timestamp of the deadline, or null when the task has none. */
  dueAt: string | null
  status: EngineTaskStatus
}

/** Half-open-ish time range in epoch ms (endMs > startMs). */
export interface Window {
  startMs: number
  endMs: number
}

/** A block the engine decided to place (pre-persistence shape). */
export interface PlannedBlock {
  taskId: string
  title: string
  startMs: number
  endMs: number
  /** Plain WHY (pressure, minutes, budget left). Atlas rewrites the voice. */
  reason: string
}

// =========================================================================
// Constants
// =========================================================================

const MS_PER_MINUTE = 60_000
const MS_PER_DAY = 86_400_000

/** §3.2 — free windows shorter than this are noise, not schedulable slots. */
const MIN_WINDOW_MINUTES = 20
const MIN_WINDOW_MS = MIN_WINDOW_MINUTES * MS_PER_MINUTE

/** §3.2 — a task with no deadline is treated as due this far out. */
const NO_DUE_DATE_DAYS = 14

/** §3.2 — divisor floor so imminent deadlines don't blow up to infinity. */
const MIN_DAYS_UNTIL_DUE = 0.5

/** §3.2 — default daily fill cap: keep >= 20% of free time as slack. */
const DEFAULT_FILL_CAP = 0.8

/** §3.3 — protection mode keeps only deadlines within this horizon. */
const PROTECTION_HORIZON_MS = 48 * 3_600_000

/**
 * §3.3 — self-report (1..5) multiplies the day's budget. null = no report.
 * Values are the DEV-SPEC §3 canonical set (aligned 2026-07-07; was 1.15/1.25).
 */
const SELF_REPORT_MULTIPLIER = [0.4, 0.7, 1.0, 1.1, 1.2] as const

/** Documented defaults for users.settings sleep_start / sleep_end. */
const DEFAULT_SLEEP_START = '00:30'
const DEFAULT_SLEEP_END = '08:30'

// =========================================================================
// pressureScore — PRODUCT-V1 §3.2
// =========================================================================

/**
 * §3.2 — pressure = (hours of work x intensity) / days until deadline.
 * The score drives fill ordering and week-level front-loading.
 *
 *   pressure = (estimatedMinutes / 60 * intensity) / max(0.5, daysUntilDue)
 *
 * No dueAt => treated as due NO_DUE_DATE_DAYS (14) days out. Overdue or
 * imminent deadlines hit the 0.5-day floor instead of dividing by <= 0.
 */
export function pressureScore(task: EngineTask, nowMs: number): number {
  const dueMs =
    task.dueAt === null ? nowMs + NO_DUE_DATE_DAYS * MS_PER_DAY : Date.parse(task.dueAt)
  const daysUntilDue = Math.max(MIN_DAYS_UNTIL_DUE, (dueMs - nowMs) / MS_PER_DAY)
  return ((task.estimatedMinutes / 60) * task.intensity) / daysUntilDue
}

// =========================================================================
// energyBudgetMinutes — PRODUCT-V1 §3.3
// =========================================================================

export interface EnergyInputs {
  /** users.settings.sleep_start, "HH:MM" (default "00:30"). */
  sleepStartHHMM: string
  /** users.settings.sleep_end, "HH:MM" (default "08:30"). */
  sleepEndHHMM: string
  /** Total minutes of class scheduled today (density deduction). */
  classMinutesToday: number
  /**
   * Today's one-tap self-report, 1..5, or null when not reported.
   * §7 red line: this value never leaves the scheduling domain.
   */
  selfReport: 1 | 2 | 3 | 4 | 5 | null
}

/** "HH:MM" -> minutes since midnight, or null when malformed. */
function hhmmToMinutes(hhmm: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!match) return null
  const hours = parseInt(match[1], 10)
  const minutes = parseInt(match[2], 10)
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

/**
 * §3.3 — energy budget for the day, in schedulable minutes.
 *
 *   baseline      = clamp((sleepWindowHours - 5.5) * 60, 60, 360)
 *   afterClasses  = max(30, baseline - classMinutesToday * 0.35)
 *   budget        = round(afterClasses * multiplier[selfReport])
 *
 * The sleep window may cross midnight ("23:00" -> "07:00" = 8h). Malformed
 * HH:MM strings fall back to the documented settings defaults. A null
 * self-report multiplies by 1.0 (no news = normal day).
 */
export function energyBudgetMinutes(i: EnergyInputs): number {
  const startMin =
    hhmmToMinutes(i.sleepStartHHMM) ?? (hhmmToMinutes(DEFAULT_SLEEP_START) as number)
  const endMin = hhmmToMinutes(i.sleepEndHHMM) ?? (hhmmToMinutes(DEFAULT_SLEEP_END) as number)
  const sleepMinutes = (endMin - startMin + 1440) % 1440
  const sleepHours = sleepMinutes / 60

  const baseline = Math.min(360, Math.max(60, (sleepHours - 5.5) * 60))
  const afterClasses = Math.max(30, baseline - i.classMinutesToday * 0.35)
  const multiplier = i.selfReport === null ? 1.0 : SELF_REPORT_MULTIPLIER[i.selfReport - 1]
  return Math.round(afterClasses * multiplier)
}

// =========================================================================
// freeWindows — PRODUCT-V1 §3.2
// =========================================================================

/**
 * §3.2 — hard constraints occupy first. Given the day bounds and the
 * occupied ranges (classes, commute buffers, locked/manual blocks), return
 * the schedulable gaps: occupied ranges are clipped to the day, sorted and
 * merged (overlapping or touching), and only gaps >= 20 minutes survive.
 * Result is sorted and non-overlapping.
 */
export function freeWindows(dayStartMs: number, dayEndMs: number, occupied: Window[]): Window[] {
  if (dayEndMs <= dayStartMs) return []

  const clipped = occupied
    .map((w) => ({
      startMs: Math.max(w.startMs, dayStartMs),
      endMs: Math.min(w.endMs, dayEndMs),
    }))
    .filter((w) => w.endMs > w.startMs)
    .sort((a, b) => a.startMs - b.startMs)

  const merged: Window[] = []
  for (const w of clipped) {
    const last = merged[merged.length - 1]
    if (last && w.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, w.endMs)
    } else {
      merged.push({ ...w })
    }
  }

  const gaps: Window[] = []
  let cursor = dayStartMs
  for (const w of merged) {
    if (w.startMs - cursor >= MIN_WINDOW_MS) gaps.push({ startMs: cursor, endMs: w.startMs })
    cursor = Math.max(cursor, w.endMs)
  }
  if (dayEndMs - cursor >= MIN_WINDOW_MS) gaps.push({ startMs: cursor, endMs: dayEndMs })
  return gaps
}

// =========================================================================
// fillSchedule — PRODUCT-V1 §3.2
// =========================================================================

export interface FillOptions {
  /** Fraction of total free-window minutes that may be filled. Default 0.8. */
  fillCap?: number
}

/**
 * §3.2 — soft-constraint fill. Places tasks into free windows:
 *
 *   - pressure-descending order (pressureScore), highest pressure first;
 *   - v0 splits nothing: a task occupies min(estimatedMinutes, room left in
 *     the window) and appears at most ONCE per day;
 *   - intensity-to-remaining-budget matching: placing a block requires
 *     remainingBudget >= blockMinutes * max(1, intensity / 3), so heavy
 *     (4-5) tasks only land while the budget is fresh, while consumption is
 *     always the raw block minutes — total placed minutes never exceed
 *     budgetMinutes;
 *   - never exceeds fillCap (default 0.8) of total free-window minutes;
 *   - leaves gaps (skips tasks) once the cap or the budget is exhausted;
 *   - never truncates a longer task into a sliver: truncation requires at
 *     least MIN_WINDOW_MINUTES of room.
 *
 * done/dropped tasks and non-positive estimates are ignored. Ties in
 * pressure break by earlier deadline, then id, so output is deterministic.
 * Returned blocks are sorted chronologically.
 */
export function fillSchedule(
  windows: Window[],
  tasks: EngineTask[],
  budgetMinutes: number,
  nowMs: number,
  opts: FillOptions = {}
): PlannedBlock[] {
  const fillCap = opts.fillCap ?? DEFAULT_FILL_CAP
  const orderedWindows = [...windows].sort((a, b) => a.startMs - b.startMs)
  const totalWindowMinutes = orderedWindows.reduce(
    (sum, w) => sum + (w.endMs - w.startMs) / MS_PER_MINUTE,
    0
  )

  let capLeft = fillCap * totalWindowMinutes
  let budgetLeft = budgetMinutes

  const dueMsOf = (t: EngineTask) =>
    t.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(t.dueAt)

  const candidates = tasks
    .filter((t) => t.status !== 'done' && t.status !== 'dropped' && t.estimatedMinutes > 0)
    .map((task) => ({ task, pressure: pressureScore(task, nowMs) }))
    .sort(
      (a, b) =>
        b.pressure - a.pressure ||
        dueMsOf(a.task) - dueMsOf(b.task) ||
        a.task.id.localeCompare(b.task.id)
    )

  // Blocks pack from the front of each window; cursors track the fill line.
  const cursors = orderedWindows.map((w) => w.startMs)
  const blocks: PlannedBlock[] = []

  for (const { task, pressure } of candidates) {
    for (let wi = 0; wi < orderedWindows.length; wi++) {
      const roomMin = (orderedWindows[wi].endMs - cursors[wi]) / MS_PER_MINUTE
      if (roomMin <= 0) continue

      const blockMin = Math.min(task.estimatedMinutes, roomMin)
      // Truncating a longer task into a <20min sliver helps nobody.
      if (blockMin < task.estimatedMinutes && roomMin < MIN_WINDOW_MINUTES) continue
      // Fill cap: keep slack in the day (§3.2 "日填充上限 80%").
      if (blockMin > capLeft) continue
      // Intensity-to-remaining-budget matching: heavy work needs headroom.
      const requiredBudget = Math.max(blockMin, blockMin * (task.intensity / 3))
      if (requiredBudget > budgetLeft) continue

      const startMs = cursors[wi]
      const endMs = startMs + blockMin * MS_PER_MINUTE
      cursors[wi] = endMs
      capLeft -= blockMin
      budgetLeft -= blockMin
      blocks.push({
        taskId: task.id,
        title: task.title,
        startMs,
        endMs,
        reason: `pressure ${pressure.toFixed(2)}; ${blockMin} min at intensity ${task.intensity}; ${Math.round(budgetLeft)} min budget left`,
      })
      break // v0: a task appears at most once per day
    }
  }

  return blocks.sort((a, b) => a.startMs - b.startMs)
}

// =========================================================================
// applyProtectionMode — PRODUCT-V1 §3.3
// =========================================================================

export interface ProtectionResult {
  kept: EngineTask[]
  dropped: EngineTask[]
  advice: string
}

/**
 * §3.3 — self-report <= 2 triggers protection mode: cut every low-priority
 * block for the day and keep ONLY tasks whose deadline is within 48 hours
 * (overdue counts as within — those are the most urgent of all). Everything
 * else is dropped for today with recovery advice.
 *
 * §7 red line: the low self-report that triggers this never leaves the
 * scheduling domain; only the resulting plan change is visible.
 */
export function applyProtectionMode(
  tasks: EngineTask[],
  nowMs: number
): ProtectionResult {
  const kept: EngineTask[] = []
  const dropped: EngineTask[] = []
  for (const task of tasks) {
    const urgent = task.dueAt !== null && Date.parse(task.dueAt) - nowMs <= PROTECTION_HORIZON_MS
    if (urgent) kept.push(task)
    else dropped.push(task)
  }

  const advice =
    dropped.length === 0
      ? 'Energy is low and nothing could be cut — everything left is due within 48 hours. Keep the blocks short and rest between them.'
      : `Energy is low. ${dropped.length} non-urgent ${
          dropped.length === 1 ? 'task' : 'tasks'
        } cleared from today; only deadlines within 48 hours remain. Rest is part of the plan.`

  return { kept, dropped, advice }
}

// =========================================================================
// shouldReduceWeeklyFill — PRODUCT-V1 §3.3
// =========================================================================

/**
 * §3.3 — three consecutive days of low self-report (<= 2) reduce the whole
 * week's fill rate (and get called out in the weekly review).
 *
 * `lastScores` is chronological; null means "no report that day" and BREAKS
 * the streak — silence is not evidence of exhaustion.
 */
export function shouldReduceWeeklyFill(lastScores: (number | null)[]): boolean {
  let run = 0
  for (const score of lastScores) {
    if (score !== null && score <= 2) {
      run += 1
      if (run >= 3) return true
    } else {
      run = 0
    }
  }
  return false
}
