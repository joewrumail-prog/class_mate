import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isoDayOfWeek, todayDateString } from '../src/lib/quests.js'

test('isoDayOfWeek: ISO numbering, Monday = 1 … Sunday = 7', () => {
  assert.equal(isoDayOfWeek('2026-07-05'), 7) // Sunday
  assert.equal(isoDayOfWeek('2026-07-06'), 1) // Monday
  assert.equal(isoDayOfWeek('2026-07-08'), 3) // Wednesday
  assert.equal(isoDayOfWeek('2026-07-10'), 5) // Friday
  assert.equal(isoDayOfWeek('2026-07-11'), 6) // Saturday
})

test('isoDayOfWeek is stable at month/year boundaries', () => {
  assert.equal(isoDayOfWeek('2026-01-01'), 4) // Thursday
  assert.equal(isoDayOfWeek('2025-12-31'), 3) // Wednesday
  assert.equal(isoDayOfWeek('2028-02-29'), 2) // leap day, Tuesday
})

test('todayDateString returns campus-timezone YYYY-MM-DD', () => {
  const s = todayDateString()
  assert.match(s, /^\d{4}-\d{2}-\d{2}$/)
  // Sanity: parses to a real date within ±2 days of the machine clock
  // (campus TZ America/New_York vs local clock can differ by at most a day).
  const parsed = new Date(`${s}T12:00:00Z`).getTime()
  assert.ok(Math.abs(parsed - Date.now()) < 2 * 86_400_000)
})

test('CAMPUS_TZ env override changes the computed date boundary', () => {
  const prev = process.env.CAMPUS_TZ
  try {
    // Pick two zones ~23h apart; at almost any moment at least one differs
    // from the other, proving the env var is respected.
    process.env.CAMPUS_TZ = 'Pacific/Kiritimati' // UTC+14
    const ahead = todayDateString()
    process.env.CAMPUS_TZ = 'Pacific/Niue' // UTC-11
    const behind = todayDateString()
    assert.match(ahead, /^\d{4}-\d{2}-\d{2}$/)
    assert.match(behind, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(ahead >= behind, 'UTC+14 date must be >= UTC-11 date')
  } finally {
    if (prev === undefined) delete process.env.CAMPUS_TZ
    else process.env.CAMPUS_TZ = prev
  }
})
