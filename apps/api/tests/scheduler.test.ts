/**
 * Pure-function tests for the scheduling engine (apps/api/src/lib/scheduler.ts)
 * and the Atlas persona voice (apps/api/src/lib/atlas.ts).
 *
 * No network, no supabase, no env: both modules are fully pure and take time
 * as caller-injected epoch ms, so nothing here touches the real clock except
 * where we construct LOCAL-time dates on purpose (easter-egg hour/date rules
 * are defined in the user's local time).
 *
 * Run: npx tsx --test tests/scheduler.test.ts   (from apps/api)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pressureScore,
  energyBudgetMinutes,
  freeWindows,
  fillSchedule,
  applyProtectionMode,
  shouldReduceWeeklyFill,
  type EngineTask,
  type Window,
} from '../src/lib/scheduler.js'
import {
  atlasMorning,
  atlasBlockReason,
  atlasProtection,
  atlasIntervention,
  maybeEasterEgg,
} from '../src/lib/atlas.js'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** Fixed "now" for every deadline-math test (UTC noon, arbitrary date). */
const NOW = Date.UTC(2026, 6, 6, 12, 0, 0)

const isoAt = (ms: number) => new Date(ms).toISOString()

let taskSeq = 0
function mkTask(overrides: Partial<EngineTask> = {}): EngineTask {
  taskSeq += 1
  return {
    id: `00000000-0000-0000-0000-${String(taskSeq).padStart(12, '0')}`,
    title: `Task ${taskSeq}`,
    estimatedMinutes: 60,
    intensity: 3,
    dueAt: null,
    status: 'pending',
    ...overrides,
  }
}

// =========================================================================
// pressureScore
// =========================================================================

describe('pressureScore', () => {
  test('basic algebra: (minutes/60 * intensity) / daysUntilDue', () => {
    // 120 min * intensity 3 = 6 pressure-hours, due in 2 days => 3.
    const task = mkTask({ estimatedMinutes: 120, intensity: 3, dueAt: isoAt(NOW + 2 * DAY) })
    assert.equal(pressureScore(task, NOW), 3)
  })

  test('scales linearly with minutes and intensity', () => {
    const base = mkTask({ estimatedMinutes: 60, intensity: 1, dueAt: isoAt(NOW + 1 * DAY) })
    const double = mkTask({ estimatedMinutes: 120, intensity: 1, dueAt: isoAt(NOW + 1 * DAY) })
    const heavy = mkTask({ estimatedMinutes: 60, intensity: 5, dueAt: isoAt(NOW + 1 * DAY) })
    assert.equal(pressureScore(double, NOW), 2 * pressureScore(base, NOW))
    assert.equal(pressureScore(heavy, NOW), 5 * pressureScore(base, NOW))
  })

  test('no dueAt is treated as due 14 days out', () => {
    const task = mkTask({ estimatedMinutes: 60, intensity: 2, dueAt: null })
    assert.equal(pressureScore(task, NOW), 2 / 14)
  })

  test('0.5-day floor: due in 6 hours divides by 0.5, not 0.25', () => {
    const task = mkTask({ estimatedMinutes: 60, intensity: 4, dueAt: isoAt(NOW + 6 * HOUR) })
    assert.equal(pressureScore(task, NOW), 4 / 0.5)
  })

  test('0.5-day floor: due exactly now and overdue also divide by 0.5', () => {
    const dueNow = mkTask({ estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW) })
    const overdue = mkTask({ estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW - 3 * DAY) })
    assert.equal(pressureScore(dueNow, NOW), 3 / 0.5)
    assert.equal(pressureScore(overdue, NOW), 3 / 0.5)
  })

  test('exactly 0.5 days out uses 0.5 (floor is not "greater than")', () => {
    const task = mkTask({ estimatedMinutes: 30, intensity: 2, dueAt: isoAt(NOW + 12 * HOUR) })
    assert.equal(pressureScore(task, NOW), (0.5 * 2) / 0.5)
  })

  test('closer deadline means strictly higher pressure', () => {
    const near = mkTask({ estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) })
    const far = mkTask({ estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 5 * DAY) })
    assert.ok(pressureScore(near, NOW) > pressureScore(far, NOW))
  })
})

// =========================================================================
// energyBudgetMinutes
// =========================================================================

describe('energyBudgetMinutes', () => {
  const base = {
    sleepStartHHMM: '00:30',
    sleepEndHHMM: '08:30',
    classMinutesToday: 0,
    selfReport: null,
  } as const

  test('default 8h sleep window => baseline 150', () => {
    // (8 - 5.5) * 60 = 150
    assert.equal(energyBudgetMinutes({ ...base }), 150)
  })

  test('sleep window crossing midnight is measured correctly', () => {
    // 23:00 -> 07:00 is also 8 hours.
    assert.equal(
      energyBudgetMinutes({ ...base, sleepStartHHMM: '23:00', sleepEndHHMM: '07:00' }),
      150
    )
  })

  test('baseline clamps high at 360', () => {
    // 20:00 -> 08:00 = 12h => (12 - 5.5) * 60 = 390 -> 360
    assert.equal(
      energyBudgetMinutes({ ...base, sleepStartHHMM: '20:00', sleepEndHHMM: '08:00' }),
      360
    )
  })

  test('baseline clamps low at 60', () => {
    // 02:00 -> 06:00 = 4h => negative raw baseline -> 60
    assert.equal(
      energyBudgetMinutes({ ...base, sleepStartHHMM: '02:00', sleepEndHHMM: '06:00' }),
      60
    )
  })

  test('class density deducts 0.35 min per class minute', () => {
    // 150 - 200 * 0.35 = 80
    assert.equal(energyBudgetMinutes({ ...base, classMinutesToday: 200 }), 80)
  })

  test('post-deduction floor is 30', () => {
    // 150 - 400 * 0.35 = 10 -> 30
    assert.equal(energyBudgetMinutes({ ...base, classMinutesToday: 400 }), 30)
    // Short sleep + heavy classes: 60 - 200*0.35 = -10 -> 30
    assert.equal(
      energyBudgetMinutes({
        ...base,
        sleepStartHHMM: '02:00',
        sleepEndHHMM: '06:00',
        classMinutesToday: 200,
      }),
      30
    )
  })

  test('self-report multipliers [0.4, 0.7, 1.0, 1.15, 1.25]', () => {
    assert.equal(energyBudgetMinutes({ ...base, selfReport: 1 }), 60) // 150 * 0.4
    assert.equal(energyBudgetMinutes({ ...base, selfReport: 2 }), 105) // 150 * 0.7
    assert.equal(energyBudgetMinutes({ ...base, selfReport: 3 }), 150) // 150 * 1.0
    assert.equal(energyBudgetMinutes({ ...base, selfReport: 4 }), 173) // round(172.5)
    assert.equal(energyBudgetMinutes({ ...base, selfReport: 5 }), 188) // round(187.5)
  })

  test('null self-report multiplies by 1.0', () => {
    assert.equal(
      energyBudgetMinutes({ ...base, selfReport: null }),
      energyBudgetMinutes({ ...base, selfReport: 3 })
    )
  })

  test('floor applies before the multiplier', () => {
    // floored 30 * 1.25 = 37.5 -> 38 (not max(30, ...) after multiplying)
    assert.equal(
      energyBudgetMinutes({ ...base, classMinutesToday: 400, selfReport: 5 }),
      38
    )
    // floored 30 * 0.4 = 12: a truly bad day can go below 30 minutes.
    assert.equal(
      energyBudgetMinutes({ ...base, classMinutesToday: 400, selfReport: 1 }),
      12
    )
  })

  test('malformed HH:MM falls back to documented defaults (8h window)', () => {
    assert.equal(
      energyBudgetMinutes({ ...base, sleepStartHHMM: 'garbage', sleepEndHHMM: '25:99' }),
      150
    )
  })
})

// =========================================================================
// freeWindows
// =========================================================================

describe('freeWindows', () => {
  const DAY_START = Date.UTC(2026, 6, 6, 9, 0, 0)
  const at = (m: number) => DAY_START + m * MIN
  const win = (startMin: number, endMin: number): Window => ({
    startMs: at(startMin),
    endMs: at(endMin),
  })

  test('no occupied ranges => the whole day is one window', () => {
    assert.deepEqual(freeWindows(at(0), at(600), []), [win(0, 600)])
  })

  test('single occupied range splits the day', () => {
    assert.deepEqual(freeWindows(at(0), at(600), [win(100, 200)]), [
      win(0, 100),
      win(200, 600),
    ])
  })

  test('overlapping occupied ranges merge', () => {
    assert.deepEqual(
      freeWindows(at(0), at(600), [win(100, 200), win(150, 300)]),
      [win(0, 100), win(300, 600)]
    )
  })

  test('touching occupied ranges merge (no zero-length gap)', () => {
    assert.deepEqual(
      freeWindows(at(0), at(600), [win(100, 200), win(200, 300)]),
      [win(0, 100), win(300, 600)]
    )
  })

  test('one occupied range fully inside another is absorbed', () => {
    assert.deepEqual(
      freeWindows(at(0), at(600), [win(100, 400), win(150, 200)]),
      [win(0, 100), win(400, 600)]
    )
  })

  test('unsorted occupied input is handled', () => {
    assert.deepEqual(
      freeWindows(at(0), at(600), [win(400, 500), win(50, 100)]),
      [win(0, 50), win(100, 400), win(500, 600)]
    )
  })

  test('gaps shorter than 20 minutes are dropped', () => {
    // Gap 100..119 = 19 min -> dropped.
    assert.deepEqual(
      freeWindows(at(0), at(600), [win(0, 100), win(119, 200)]),
      [win(200, 600)]
    )
  })

  test('a gap of exactly 20 minutes survives', () => {
    assert.deepEqual(
      freeWindows(at(0), at(600), [win(0, 100), win(120, 200)]),
      [win(100, 120), win(200, 600)]
    )
  })

  test('occupied ranges are clipped to the day bounds', () => {
    // Starts before the day, ends inside it.
    assert.deepEqual(freeWindows(at(0), at(600), [win(-50, 30)]), [win(30, 600)])
    // Starts inside, ends after.
    assert.deepEqual(freeWindows(at(0), at(600), [win(550, 700)]), [win(0, 550)])
  })

  test('occupied ranges entirely outside the day are ignored', () => {
    assert.deepEqual(freeWindows(at(0), at(600), [win(700, 800), win(-100, -10)]), [
      win(0, 600),
    ])
  })

  test('a fully occupied day yields no windows', () => {
    assert.deepEqual(freeWindows(at(0), at(600), [win(0, 600)]), [])
  })

  test('degenerate day bounds yield no windows', () => {
    assert.deepEqual(freeWindows(at(0), at(0), []), [])
    assert.deepEqual(freeWindows(at(100), at(50), []), [])
    // A 19-minute day is below the minimum window size.
    assert.deepEqual(freeWindows(at(0), at(19), []), [])
  })
})

// =========================================================================
// fillSchedule
// =========================================================================

describe('fillSchedule', () => {
  const DAY_START = Date.UTC(2026, 6, 6, 9, 0, 0)
  const at = (m: number) => DAY_START + m * MIN
  const win = (startMin: number, endMin: number): Window => ({
    startMs: at(startMin),
    endMs: at(endMin),
  })
  const minutesOf = (b: { startMs: number; endMs: number }) => (b.endMs - b.startMs) / MIN

  test('places the highest-pressure task first, at the front of the day', () => {
    const low = mkTask({ id: 'low', estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 5 * DAY) })
    const high = mkTask({ id: 'high', estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) })
    // Given in "wrong" order on purpose.
    const blocks = fillSchedule([win(0, 300)], [low, high], 500, NOW)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].taskId, 'high')
    assert.equal(blocks[0].startMs, at(0))
    assert.equal(blocks[1].taskId, 'low')
    assert.equal(blocks[1].startMs, at(60))
  })

  test('a low-pressure task is excluded once the budget is spent on higher pressure', () => {
    const high = mkTask({ id: 'high', estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) })
    const low = mkTask({ id: 'low', estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 6 * DAY) })
    // Budget fits exactly one 60-minute block; window has room for both.
    const blocks = fillSchedule([win(0, 240)], [low, high], 60, NOW)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].taskId, 'high')
  })

  test('never exceeds fillCap (default 0.8) of total window minutes', () => {
    const a = mkTask({ id: 'a', estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) })
    const b = mkTask({ id: 'b', estimatedMinutes: 30, intensity: 3, dueAt: isoAt(NOW + 2 * DAY) })
    // Window 100 min -> cap 80. After a (60), only 20 cap-min remain; b (30)
    // does not fit and is skipped even though the window has 40 min of room.
    const blocks = fillSchedule([win(0, 100)], [a, b], 500, NOW)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].taskId, 'a')
    const placed = blocks.reduce((s, x) => s + minutesOf(x), 0)
    assert.ok(placed <= 80)
  })

  test('custom fillCap is honored', () => {
    const long = mkTask({ id: 'long', estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) })
    const short = mkTask({ id: 'short', estimatedMinutes: 40, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) })
    // Window 100 min, cap 0.5 -> 50 placeable minutes.
    assert.equal(fillSchedule([win(0, 100)], [long], 500, NOW, { fillCap: 0.5 }).length, 0)
    const blocks = fillSchedule([win(0, 100)], [short], 500, NOW, { fillCap: 0.5 })
    assert.equal(blocks.length, 1)
    assert.equal(minutesOf(blocks[0]), 40)
  })

  test('never exceeds budgetMinutes', () => {
    const task = mkTask({ estimatedMinutes: 60, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) })
    assert.deepEqual(fillSchedule([win(0, 300)], [task], 50, NOW), [])
    const tasks = [
      mkTask({ estimatedMinutes: 45, intensity: 3, dueAt: isoAt(NOW + 1 * DAY) }),
      mkTask({ estimatedMinutes: 45, intensity: 3, dueAt: isoAt(NOW + 2 * DAY) }),
      mkTask({ estimatedMinutes: 45, intensity: 3, dueAt: isoAt(NOW + 3 * DAY) }),
    ]
    const blocks = fillSchedule([win(0, 600)], tasks, 100, NOW)
    const placed = blocks.reduce((s, x) => s + minutesOf(x), 0)
    assert.ok(placed <= 100)
    assert.equal(blocks.length, 2) // 45 + 45 = 90; a third 45 would breach 100
  })

  test('intensity-to-remaining-budget matching: heavy tasks need fresh budget', () => {
    // Budget 100. First: intensity-5, 60 min -> needs 60 * 5/3 = 100 headroom,
    // placed while fresh, consumes 60 (budget left: 40).
    // Second: intensity-5, 30 min -> needs 30 * 5/3 = 50 > 40, skipped even
    // though its raw 30 minutes would fit.
    // Third: intensity-1, 30 min -> needs max(30, 10) = 30 <= 40, placed.
    const heavyBig = mkTask({ id: 'heavy-big', estimatedMinutes: 60, intensity: 5, dueAt: isoAt(NOW + 1 * DAY) })
    const heavySmall = mkTask({ id: 'heavy-small', estimatedMinutes: 30, intensity: 5, dueAt: isoAt(NOW + 2 * DAY) })
    const light = mkTask({ id: 'light', estimatedMinutes: 30, intensity: 1, dueAt: isoAt(NOW + 3 * DAY) })
    const blocks = fillSchedule([win(0, 400)], [heavyBig, heavySmall, light], 100, NOW)
    assert.deepEqual(blocks.map((b) => b.taskId), ['heavy-big', 'light'])
    // Raw consumption still never exceeds the budget.
    assert.ok(blocks.reduce((s, x) => s + minutesOf(x), 0) <= 100)
  })

  test('v0 splits nothing: a task appears at most once per day', () => {
    const long = mkTask({ id: 'long', estimatedMinutes: 200, intensity: 1, dueAt: isoAt(NOW + 1 * DAY) })
    const blocks = fillSchedule([win(0, 60), win(120, 180)], [long], 500, NOW)
    assert.equal(blocks.length, 1)
    assert.equal(minutesOf(blocks[0]), 60) // min(estimated, window length)
  })

  test('a task occupies min(estimatedMinutes, window room)', () => {
    // fillCap:1 isolates the min(est, room) rule — at the default 0.8 cap a
    // 60-minute block correctly does NOT fit into a 60-minute day (§3.2).
    const task = mkTask({ estimatedMinutes: 90, intensity: 2, dueAt: isoAt(NOW + 1 * DAY) })
    const blocks = fillSchedule([win(0, 60)], [task], 500, NOW, { fillCap: 1 })
    assert.equal(blocks.length, 1)
    assert.equal(minutesOf(blocks[0]), 60)

    // And the default cap refuses it — the gap is the product intent.
    assert.equal(fillSchedule([win(0, 60)], [task], 500, NOW).length, 0)
  })

  test('does not truncate a longer task into a sub-20-minute sliver', () => {
    const first = mkTask({ id: 'first', estimatedMinutes: 50, intensity: 1, dueAt: isoAt(NOW + 1 * DAY) })
    const second = mkTask({ id: 'second', estimatedMinutes: 60, intensity: 1, dueAt: isoAt(NOW + 2 * DAY) })
    // Window 65 min: after `first` (50), 15 min of room remain — too small to
    // truncate `second` into.
    const blocks = fillSchedule([win(0, 65)], [first, second], 500, NOW)
    assert.deepEqual(blocks.map((b) => b.taskId), ['first'])
  })

  test('done and dropped tasks are never scheduled', () => {
    const done = mkTask({ status: 'done', dueAt: isoAt(NOW + 1 * DAY) })
    const dropped = mkTask({ status: 'dropped', dueAt: isoAt(NOW + 1 * DAY) })
    assert.deepEqual(fillSchedule([win(0, 300)], [done, dropped], 500, NOW), [])
  })

  test('blocks stay inside their windows and are returned chronologically', () => {
    const windows = [win(200, 300), win(0, 100)] // unsorted on purpose
    const tasks = [
      mkTask({ id: 't1', estimatedMinutes: 60, intensity: 2, dueAt: isoAt(NOW + 1 * DAY) }),
      mkTask({ id: 't2', estimatedMinutes: 60, intensity: 2, dueAt: isoAt(NOW + 2 * DAY) }),
    ]
    const blocks = fillSchedule(windows, tasks, 500, NOW)
    assert.equal(blocks.length, 2)
    for (let i = 1; i < blocks.length; i++) {
      assert.ok(blocks[i].startMs >= blocks[i - 1].endMs)
    }
    for (const b of blocks) {
      const home = windows.find((w) => b.startMs >= w.startMs && b.endMs <= w.endMs)
      assert.ok(home, `block ${b.taskId} escaped every window`)
    }
  })

  test('every placed block carries a non-empty reason with its minutes', () => {
    const task = mkTask({ estimatedMinutes: 60, intensity: 4, dueAt: isoAt(NOW + 1 * DAY) })
    const [block] = fillSchedule([win(0, 300)], [task], 500, NOW)
    assert.ok(block.reason.length > 0)
    assert.ok(block.reason.includes('60 min'))
  })

  test('empty inputs yield an empty plan', () => {
    assert.deepEqual(fillSchedule([], [mkTask()], 500, NOW), [])
    assert.deepEqual(fillSchedule([win(0, 300)], [], 500, NOW), [])
    assert.deepEqual(fillSchedule([win(0, 300)], [mkTask()], 0, NOW), [])
  })
})

// =========================================================================
// applyProtectionMode
// =========================================================================

describe('applyProtectionMode', () => {
  test('keeps only tasks due within 48 hours', () => {
    const soon = mkTask({ id: 'soon', dueAt: isoAt(NOW + 47 * HOUR) })
    const later = mkTask({ id: 'later', dueAt: isoAt(NOW + 49 * HOUR) })
    const never = mkTask({ id: 'never', dueAt: null })
    const { kept, dropped } = applyProtectionMode([soon, later, never], NOW)
    assert.deepEqual(kept.map((t) => t.id), ['soon'])
    assert.deepEqual(dropped.map((t) => t.id), ['later', 'never'])
  })

  test('exactly 48 hours out is still kept (boundary is inclusive)', () => {
    const edge = mkTask({ id: 'edge', dueAt: isoAt(NOW + 48 * HOUR) })
    const past = mkTask({ id: 'past', dueAt: isoAt(NOW + 48 * HOUR + MIN) })
    const { kept, dropped } = applyProtectionMode([edge, past], NOW)
    assert.deepEqual(kept.map((t) => t.id), ['edge'])
    assert.deepEqual(dropped.map((t) => t.id), ['past'])
  })

  test('overdue tasks count as urgent and are kept', () => {
    const overdue = mkTask({ id: 'overdue', dueAt: isoAt(NOW - DAY) })
    const { kept, dropped } = applyProtectionMode([overdue], NOW)
    assert.deepEqual(kept.map((t) => t.id), ['overdue'])
    assert.equal(dropped.length, 0)
  })

  test('advice is always non-empty and mentions the 48-hour rule', () => {
    const withDrops = applyProtectionMode([mkTask({ dueAt: null })], NOW)
    assert.ok(withDrops.advice.length > 0)
    assert.ok(withDrops.advice.includes('48'))
    assert.ok(withDrops.advice.includes('1'))

    const noDrops = applyProtectionMode([mkTask({ dueAt: isoAt(NOW + HOUR) })], NOW)
    assert.ok(noDrops.advice.length > 0)
    assert.ok(noDrops.advice.includes('48'))
  })

  test('empty input: nothing kept, nothing dropped, advice still present', () => {
    const result = applyProtectionMode([], NOW)
    assert.deepEqual(result.kept, [])
    assert.deepEqual(result.dropped, [])
    assert.ok(result.advice.length > 0)
  })
})

// =========================================================================
// shouldReduceWeeklyFill
// =========================================================================

describe('shouldReduceWeeklyFill', () => {
  test('three consecutive scores <= 2 trigger the reduction', () => {
    assert.equal(shouldReduceWeeklyFill([1, 2, 2]), true)
    assert.equal(shouldReduceWeeklyFill([3, 2, 2, 2]), true)
    assert.equal(shouldReduceWeeklyFill([2, 2, 2, 5]), true)
    assert.equal(shouldReduceWeeklyFill([5, 5, 1, 1, 1, 5]), true)
  })

  test('fewer than three consecutive lows do not trigger', () => {
    assert.equal(shouldReduceWeeklyFill([]), false)
    assert.equal(shouldReduceWeeklyFill([2, 2]), false)
    assert.equal(shouldReduceWeeklyFill([2, 2, 3, 2, 2]), false)
    assert.equal(shouldReduceWeeklyFill([1, 3, 1, 3, 1]), false)
  })

  test('a score of 3 breaks the streak; the boundary is <= 2', () => {
    assert.equal(shouldReduceWeeklyFill([2, 2, 3]), false)
    assert.equal(shouldReduceWeeklyFill([3, 3, 3]), false)
    assert.equal(shouldReduceWeeklyFill([2, 2, 2]), true)
  })

  test('null (no report) breaks the streak — silence is not exhaustion', () => {
    assert.equal(shouldReduceWeeklyFill([2, null, 2, 2]), false)
    assert.equal(shouldReduceWeeklyFill([2, 2, null]), false)
    assert.equal(shouldReduceWeeklyFill([null, 2, 2, 2]), true)
    assert.equal(shouldReduceWeeklyFill([null, null, null]), false)
  })
})

// =========================================================================
// Atlas voice builders
// =========================================================================

describe('atlas voice', () => {
  const noExclamation = (s: string) => assert.ok(!s.includes('!'), `has "!": ${s}`)

  test('atlasMorning includes main, sides, and the budget number', () => {
    const msg = atlasMorning('CS336 assignment', ['gym', 'reading'], 180)
    assert.ok(msg.length > 0)
    assert.ok(msg.includes('CS336 assignment'))
    assert.ok(msg.includes('gym'))
    assert.ok(msg.includes('reading'))
    assert.ok(msg.includes('180'))
    noExclamation(msg)
  })

  test('atlasMorning handles a null main and an empty day', () => {
    const noMain = atlasMorning(null, ['gym'], 120)
    assert.ok(noMain.length > 0)
    assert.ok(noMain.includes('gym'))
    assert.ok(noMain.includes('120'))
    noExclamation(noMain)

    const empty = atlasMorning(null, [], 90)
    assert.ok(empty.length > 0)
    assert.ok(empty.includes('90'))
    noExclamation(empty)
  })

  test('atlasBlockReason states minutes, budget left, and pressure', () => {
    const task = mkTask({
      title: 'CS336 problem set',
      estimatedMinutes: 75,
      intensity: 4,
      dueAt: isoAt(NOW + DAY),
    })
    const msg = atlasBlockReason(task, 3.27, 140)
    assert.ok(msg.length > 0)
    assert.ok(msg.includes('CS336 problem set'))
    assert.ok(msg.includes('75'))
    assert.ok(msg.includes('140'))
    assert.ok(msg.includes('3.3')) // pressure to one decimal
    noExclamation(msg)
  })

  test('atlasBlockReason handles a task with no deadline', () => {
    const task = mkTask({ title: 'Gym', estimatedMinutes: 60, intensity: 3, dueAt: null })
    const msg = atlasBlockReason(task, 0.4, 100)
    assert.ok(msg.includes('60'))
    assert.ok(msg.includes('100'))
    assert.ok(msg.includes('0.4'))
    noExclamation(msg)
  })

  test('atlasProtection includes the dropped count for 0, 1, and many', () => {
    for (const n of [0, 1, 4]) {
      const msg = atlasProtection(n)
      assert.ok(msg.length > 0)
      assert.ok(msg.includes(String(n)), `missing count ${n}: ${msg}`)
      noExclamation(msg)
    }
  })

  test('atlasIntervention includes what moved, where, and why', () => {
    const msg = atlasIntervention(
      "Thursday's gym",
      'Saturday morning',
      'this week is overloaded'
    )
    assert.ok(msg.length > 0)
    assert.ok(msg.includes("Thursday's gym"))
    assert.ok(msg.includes('Saturday morning'))
    assert.ok(msg.includes('this week is overloaded'))
    noExclamation(msg)
  })
})

// =========================================================================
// maybeEasterEgg
// =========================================================================

describe('maybeEasterEgg', () => {
  // Easter-egg hour/date rules are LOCAL time, so build local-time dates.
  const localMs = (
    year: number,
    monthIdx: number,
    day: number,
    hour: number,
    minute = 0
  ) => new Date(year, monthIdx, day, hour, minute, 0, 0).getTime()

  // 2026-06-09 is a plain Tuesday; noon is the most ordinary moment there is.
  const plainTuesdayNoon = localMs(2026, 5, 9, 12)

  test('returns null on a plain Tuesday noon with an ordinary ctx', () => {
    assert.equal(maybeEasterEgg({ nowMs: plainTuesdayNoon }), null)
    assert.equal(
      maybeEasterEgg({
        nowMs: plainTuesdayNoon,
        streakDays: 3,
        pressure: 7.5,
        allScoresFive: false,
      }),
      null
    )
  })

  test('02:00-04:59 local fires the go-sleep line', () => {
    for (const hour of [2, 3, 4]) {
      const egg = maybeEasterEgg({ nowMs: localMs(2026, 5, 9, hour, 30) })
      assert.ok(egg !== null, `no egg at hour ${hour}`)
      assert.ok(egg.toLowerCase().includes('sleep'))
    }
    // 04:59 fires; 05:00 and 01:59 do not.
    assert.notEqual(maybeEasterEgg({ nowMs: localMs(2026, 5, 9, 4, 59) }), null)
    assert.equal(maybeEasterEgg({ nowMs: localMs(2026, 5, 9, 5, 0) }), null)
    assert.equal(maybeEasterEgg({ nowMs: localMs(2026, 5, 9, 1, 59) }), null)
  })

  test('streakDays exactly 7 fires the consistency monologue (one-time)', () => {
    const egg = maybeEasterEgg({ nowMs: plainTuesdayNoon, streakDays: 7 })
    assert.ok(egg !== null)
    assert.ok(egg.toLowerCase().includes('seven'))
    // Only exactly 7 — not 6, not 8, not 14.
    for (const days of [6, 8, 14]) {
      assert.equal(maybeEasterEgg({ nowMs: plainTuesdayNoon, streakDays: days }), null)
    }
  })

  test('pressure rounding to exactly 42 fires the parenthetical', () => {
    for (const p of [42, 41.6, 42.4]) {
      const egg = maybeEasterEgg({ nowMs: plainTuesdayNoon, pressure: p })
      assert.ok(egg !== null, `no egg for pressure ${p}`)
      assert.ok(egg.includes('the answer to life'))
      assert.ok(egg.startsWith('(') && egg.endsWith(')'), 'appendable parenthetical')
    }
    for (const p of [41.4, 42.5, 0, 100]) {
      assert.equal(maybeEasterEgg({ nowMs: plainTuesdayNoon, pressure: p }), null)
    }
  })

  test('five straight 5/5 energy days fires the barely-need-me line', () => {
    const egg = maybeEasterEgg({ nowMs: plainTuesdayNoon, allScoresFive: true })
    assert.ok(egg !== null)
    assert.ok(egg.includes('here anyway'))
    assert.equal(maybeEasterEgg({ nowMs: plainTuesdayNoon, allScoresFive: false }), null)
  })

  test('April 1st fires the pomodoro line', () => {
    const egg = maybeEasterEgg({ nowMs: localMs(2027, 3, 1, 12) })
    assert.ok(egg !== null)
    assert.ok(egg.toLowerCase().includes('pomodoro'))
    // April 2nd is a normal day again.
    assert.equal(maybeEasterEgg({ nowMs: localMs(2027, 3, 2, 12) }), null)
  })

  test('at most ONE egg per call even when several triggers hold', () => {
    // 3am + 7-day streak + pressure 42 + perfect week: the late-night line
    // wins and nothing is concatenated.
    const egg = maybeEasterEgg({
      nowMs: localMs(2026, 5, 9, 3, 0),
      streakDays: 7,
      pressure: 42,
      allScoresFive: true,
    })
    assert.ok(egg !== null)
    assert.ok(egg.toLowerCase().includes('sleep'))
    assert.ok(!egg.toLowerCase().includes('seven'))
    assert.ok(!egg.includes('the answer to life'))
    assert.ok(!egg.includes('here anyway'))
  })

  test('deterministic: same ctx always yields the same string', () => {
    const ctx = { nowMs: plainTuesdayNoon, streakDays: 7 }
    assert.equal(maybeEasterEgg(ctx), maybeEasterEgg({ ...ctx }))
  })

  test('eggs stay dry: at most one exclamation mark each', () => {
    const eggs = [
      maybeEasterEgg({ nowMs: localMs(2026, 5, 9, 3) }),
      maybeEasterEgg({ nowMs: plainTuesdayNoon, streakDays: 7 }),
      maybeEasterEgg({ nowMs: plainTuesdayNoon, pressure: 42 }),
      maybeEasterEgg({ nowMs: plainTuesdayNoon, allScoresFive: true }),
      maybeEasterEgg({ nowMs: localMs(2027, 3, 1, 12) }),
    ]
    for (const egg of eggs) {
      assert.ok(egg !== null)
      const bangs = (egg.match(/!/g) || []).length
      assert.ok(bangs <= 1, `too excited: ${egg}`)
    }
  })
})
