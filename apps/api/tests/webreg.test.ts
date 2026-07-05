/**
 * Pure-function tests for the WebReg resilient adapter
 * (apps/api/src/lib/webreg.ts). No network, no supabase, no env: only the
 * pure exports are imported, and the module keeps its supabase import lazy
 * inside the IO functions.
 *
 * Run: npx tsx --test tests/webreg.test.ts   (from apps/api)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeBackoffMs,
  nextBreakerState,
  promoteIfCooldownExpired,
  breakerAllowsRequest,
  initialBreakerState,
  BREAKER_DEFAULTS,
  type BreakerState,
} from '../src/lib/webreg.js'

const jitterMax = () => 1
const jitterZero = () => 0
const jitterHalf = () => 0.5

describe('computeBackoffMs', () => {
  test('doubles per attempt from baseMs (jitter pinned to 1)', () => {
    assert.equal(computeBackoffMs(0, 2_000, 300_000, jitterMax), 2_000)
    assert.equal(computeBackoffMs(1, 2_000, 300_000, jitterMax), 4_000)
    assert.equal(computeBackoffMs(2, 2_000, 300_000, jitterMax), 8_000)
    assert.equal(computeBackoffMs(3, 2_000, 300_000, jitterMax), 16_000)
    assert.equal(computeBackoffMs(4, 2_000, 300_000, jitterMax), 32_000)
  })

  test('caps at capMs', () => {
    // 2000 * 2^8 = 512_000 > 300_000 cap
    assert.equal(computeBackoffMs(8, 2_000, 300_000, jitterMax), 300_000)
    assert.equal(computeBackoffMs(30, 2_000, 300_000, jitterMax), 300_000)
    // custom cap
    assert.equal(computeBackoffMs(10, 1_000, 5_000, jitterMax), 5_000)
  })

  test('respects custom baseMs', () => {
    assert.equal(computeBackoffMs(0, 500, 300_000, jitterMax), 500)
    assert.equal(computeBackoffMs(3, 500, 300_000, jitterMax), 4_000)
  })

  test('full jitter scales the raw exponential value', () => {
    assert.equal(computeBackoffMs(2, 2_000, 300_000, jitterZero), 0)
    assert.equal(computeBackoffMs(2, 2_000, 300_000, jitterHalf), 4_000)
    assert.equal(computeBackoffMs(8, 2_000, 300_000, jitterHalf), 150_000)
  })

  test('jitter output stays within [0, raw] for every attempt', () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      const raw = computeBackoffMs(attempt, 2_000, 300_000, jitterMax)
      for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
        const value = computeBackoffMs(attempt, 2_000, 300_000, () => r)
        assert.ok(value >= 0, `attempt ${attempt} r=${r}: ${value} < 0`)
        assert.ok(value <= raw, `attempt ${attempt} r=${r}: ${value} > ${raw}`)
        assert.equal(value, Math.floor(r * raw))
      }
    }
  })

  test('negative attempt is clamped to attempt 0', () => {
    assert.equal(computeBackoffMs(-3, 2_000, 300_000, jitterMax), 2_000)
  })
})

describe('nextBreakerState', () => {
  const T0 = 1_000_000
  const { failureThreshold, openCooldownMs } = BREAKER_DEFAULTS

  const failN = (state: BreakerState, n: number, at: number): BreakerState => {
    let s = state
    for (let i = 0; i < n; i++) s = nextBreakerState(s, 'fail', at)
    return s
  }

  test('initial state is closed with no failures', () => {
    assert.deepEqual(initialBreakerState(), {
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: null,
    })
  })

  test('closed + ok stays closed and clears the failure streak', () => {
    const dirty = failN(initialBreakerState(), 3, T0)
    assert.equal(dirty.state, 'closed')
    assert.equal(dirty.consecutiveFailures, 3)

    const healed = nextBreakerState(dirty, 'ok', T0 + 1)
    assert.deepEqual(healed, { state: 'closed', consecutiveFailures: 0, openedAt: null })
  })

  test('closed accumulates failures below the threshold', () => {
    const s = failN(initialBreakerState(), failureThreshold - 1, T0)
    assert.equal(s.state, 'closed')
    assert.equal(s.consecutiveFailures, failureThreshold - 1)
    assert.equal(s.openedAt, null)
  })

  test('closed -> open exactly at the failure threshold, anchored at now', () => {
    const s = failN(initialBreakerState(), failureThreshold, T0)
    assert.equal(s.state, 'open')
    assert.equal(s.consecutiveFailures, failureThreshold)
    assert.equal(s.openedAt, T0)
  })

  test('custom failureThreshold is honored', () => {
    const opts = { failureThreshold: 2 }
    let s = nextBreakerState(initialBreakerState(), 'fail', T0, opts)
    assert.equal(s.state, 'closed')
    s = nextBreakerState(s, 'fail', T0, opts)
    assert.equal(s.state, 'open')
    assert.equal(s.openedAt, T0)
  })

  test('open stays open before the cooldown expires', () => {
    const open = failN(initialBreakerState(), failureThreshold, T0)
    const justBefore = T0 + openCooldownMs - 1

    assert.equal(promoteIfCooldownExpired(open, justBefore).state, 'open')
    assert.equal(breakerAllowsRequest(open, justBefore), false)

    // A failure while open keeps the original cooldown anchor.
    const stillOpen = nextBreakerState(open, 'fail', justBefore)
    assert.equal(stillOpen.state, 'open')
    assert.equal(stillOpen.openedAt, T0)
  })

  test('open -> half_open once the cooldown expires', () => {
    const open = failN(initialBreakerState(), failureThreshold, T0)
    const afterCooldown = T0 + openCooldownMs

    const promoted = promoteIfCooldownExpired(open, afterCooldown)
    assert.equal(promoted.state, 'half_open')
    assert.equal(breakerAllowsRequest(open, afterCooldown), true)
  })

  test('custom openCooldownMs is honored', () => {
    const opts = { openCooldownMs: 1_000 }
    const open = failN(initialBreakerState(), failureThreshold, T0)
    assert.equal(promoteIfCooldownExpired(open, T0 + 999, opts).state, 'open')
    assert.equal(promoteIfCooldownExpired(open, T0 + 1_000, opts).state, 'half_open')
  })

  test('half_open + ok -> closed with everything reset', () => {
    const open = failN(initialBreakerState(), failureThreshold, T0)
    const halfOpen = promoteIfCooldownExpired(open, T0 + openCooldownMs)

    const closed = nextBreakerState(halfOpen, 'ok', T0 + openCooldownMs)
    assert.deepEqual(closed, { state: 'closed', consecutiveFailures: 0, openedAt: null })
  })

  test('half_open + fail -> open with a fresh cooldown anchor', () => {
    const open = failN(initialBreakerState(), failureThreshold, T0)
    const probeAt = T0 + openCooldownMs
    const halfOpen = promoteIfCooldownExpired(open, probeAt)

    const reopened = nextBreakerState(halfOpen, 'fail', probeAt)
    assert.equal(reopened.state, 'open')
    assert.equal(reopened.openedAt, probeAt)
    assert.equal(reopened.consecutiveFailures, failureThreshold + 1)

    // The new anchor restarts the cooldown clock.
    assert.equal(breakerAllowsRequest(reopened, probeAt + openCooldownMs - 1), false)
    assert.equal(breakerAllowsRequest(reopened, probeAt + openCooldownMs), true)
  })

  test('open with expired cooldown auto-promotes: ok -> closed, fail -> re-open', () => {
    const open = failN(initialBreakerState(), failureThreshold, T0)
    const probeAt = T0 + openCooldownMs + 5

    const healed = nextBreakerState(open, 'ok', probeAt)
    assert.equal(healed.state, 'closed')
    assert.equal(healed.consecutiveFailures, 0)

    const reopened = nextBreakerState(open, 'fail', probeAt)
    assert.equal(reopened.state, 'open')
    assert.equal(reopened.openedAt, probeAt)
  })

  test('full lifecycle: closed -> open -> half_open -> open -> half_open -> closed', () => {
    let s = failN(initialBreakerState(), failureThreshold, T0)
    assert.equal(s.state, 'open')

    // First cooldown expiry: probe fails, breaker re-opens.
    const probe1 = T0 + openCooldownMs
    s = nextBreakerState(s, 'fail', probe1)
    assert.equal(s.state, 'open')
    assert.equal(s.openedAt, probe1)

    // Second cooldown expiry: probe succeeds, breaker closes.
    const probe2 = probe1 + openCooldownMs
    assert.equal(promoteIfCooldownExpired(s, probe2).state, 'half_open')
    s = nextBreakerState(s, 'ok', probe2)
    assert.deepEqual(s, { state: 'closed', consecutiveFailures: 0, openedAt: null })
  })
})
