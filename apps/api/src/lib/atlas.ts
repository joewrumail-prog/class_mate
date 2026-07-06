/**
 * Atlas — the System persona voice (PRODUCT-V1 §3.4).
 *
 * Like a xianxia-novel "System": it issues tasks, gives feedback, guards
 * long-term goals. Calm, reliable, few words. Never a chatbot, never
 * cheerleading. No XP, no badges, no leaderboards — this is not
 * gamification. Every message states the WHY in one short clause: minutes,
 * energy fit, or deadline pressure. No emoji. No exclamation marks, except
 * at most one inside an easter egg.
 *
 * EASTER EGGS: must stay rare and dry — they are the system accidentally
 * showing personality, not the system performing. Max one per call,
 * deterministic given ctx, triggers only on the curated conditions below.
 *
 * File layout:
 *   1. PURE only — no env, no supabase, no network, no Date.now(): callers
 *      inject time via ctx.nowMs. apps/api/tests/scheduler.test.ts imports
 *      this file with zero setup.
 *
 * All strings are English — the product ships English-first at Rutgers.
 */

import type { EngineTask } from './scheduler.js'

// =========================================================================
// Daily briefing — PRODUCT-V1 §3.4 ("早晨给今日主线 + 支线")
// =========================================================================

/**
 * §3.4 — the morning message: today's main task, side tasks, and the energy
 * budget. Calm inventory, not a pep talk.
 */
export function atlasMorning(
  main: string | null,
  sides: string[],
  budgetMinutes: number
): string {
  const parts: string[] = []
  if (main) {
    parts.push(`Main: ${main}.`)
  } else {
    parts.push('No main task today.')
  }
  if (sides.length > 0) {
    parts.push(`Side: ${sides.join(', ')}.`)
  } else if (!main) {
    parts.push('Nothing queued.')
  }
  parts.push(`Energy budget: ${budgetMinutes} min.`)
  if (!main && sides.length === 0) {
    parts.push('Spend it on yourself.')
  }
  return parts.join(' ')
}

// =========================================================================
// Block reason — PRODUCT-V1 §3.4 ("当前最优任务（含理由）")
// =========================================================================

/**
 * §3.4 — why THIS task, now. States the minutes, the energy fit against the
 * remaining budget, and the deadline pressure. One breath, no fluff.
 */
export function atlasBlockReason(
  task: EngineTask,
  pressure: number,
  budgetLeft: number
): string {
  const fit = task.intensity >= 4 ? 'heavy' : task.intensity <= 2 ? 'light' : 'steady'
  const deadline = task.dueAt
    ? `Deadline pressure ${pressure.toFixed(1)}.`
    : `Pressure ${pressure.toFixed(1)}, no deadline — clearing it now keeps the week flat.`
  return `${task.title} next. ${task.estimatedMinutes} min of ${fit} work against the ${budgetLeft} min of energy you have left. ${deadline}`
}

// =========================================================================
// Protection mode — PRODUCT-V1 §3.3 / §3.4
// =========================================================================

/**
 * §3.3/§3.4 — announced when a low self-report cleared the day down to
 * near-deadline work. States what was cut and why rest is the correct move.
 */
export function atlasProtection(droppedCount: number): string {
  if (droppedCount === 0) {
    return 'Energy is low. 0 blocks cleared — everything left is due within 48 hours. Keep them short, rest in between.'
  }
  const noun = droppedCount === 1 ? 'block' : 'blocks'
  return `Energy is low. I cleared ${droppedCount} ${noun}; only deadlines within 48 hours remain. Rest is part of the plan.`
}

// =========================================================================
// Load intervention — PRODUCT-V1 §3.4 ("劳累干预")
// =========================================================================

/**
 * §3.4 — proactive load-shedding, e.g. "moved Thursday's gym to Saturday,
 * CS336 moved to tonight's energy peak". States what moved, where, and why.
 */
export function atlasIntervention(movedWhat: string, toWhen: string, why: string): string {
  return `Moved ${movedWhat} to ${toWhen} — ${why}. The plan absorbs it so you do not have to.`
}

// =========================================================================
// Easter eggs — rare, dry, deterministic
// =========================================================================

export interface EasterEggContext {
  /** Caller-injected clock (epoch ms); hours/date read in local time. */
  nowMs: number
  /** Consecutive days the daily plan was claimed. */
  streakDays?: number
  /** Current pressure score, if the caller has one in hand. */
  pressure?: number
  /** True when the last five self-reports were all 5/5. */
  allScoresFive?: boolean
}

/**
 * §3.4 — at most ONE egg per call, deterministic given ctx. Priority order
 * (first match wins): late night > April 1 > 7-day streak > pressure 42 >
 * five straight 5/5 days. Returns null on an ordinary day, which is almost
 * every day — that is the point.
 */
export function maybeEasterEgg(ctx: EasterEggContext): string | null {
  const now = new Date(ctx.nowMs)
  const hour = now.getHours()

  // 02:00-04:59 local: the plan is patient, the user should be asleep.
  if (hour >= 2 && hour < 5) {
    return 'It is 3am. The plan will still be here tomorrow. Go sleep.'
  }

  // April 1st: the one day Atlas admits to having considered a career change.
  if (now.getMonth() === 3 && now.getDate() === 1) {
    return 'I briefly considered becoming a pomodoro timer today. Decided against it. A tomato cannot see your whole week.'
  }

  // Exactly 7 days of claiming the plan: a one-time monologue on consistency.
  if (ctx.streakDays === 7) {
    return 'Seven days of taking the plan. Most stop at two. Consistency is the entire trick — the rest of what I do is arithmetic.'
  }

  // Pressure rounds to exactly 42. Appended by the caller to the reason line.
  if (ctx.pressure !== undefined && Math.round(ctx.pressure) === 42) {
    return '(the answer to life, the universe, and this deadline)'
  }

  // Five days straight at 5/5 energy.
  if (ctx.allScoresFive) {
    return 'Five days at full energy. You barely need me this week. I will be here anyway.'
  }

  return null
}
