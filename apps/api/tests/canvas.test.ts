/**
 * Pure-function tests for the Canvas integration
 * (apps/api/src/lib/canvas.ts). No network, no supabase, no env: only the
 * PURE-section exports are imported, and the module keeps its supabase
 * import lazy inside the IO functions.
 *
 * Run: npx tsx --test tests/canvas.test.ts   (from apps/api)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  encryptToken,
  decryptToken,
  mapAssignmentsToTasks,
  type CanvasAssignment,
} from '../src/lib/canvas.js'

// Deterministic 32-byte keys (only the tests know them; nothing real).
const KEY = Buffer.alloc(32, 7).toString('base64')
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64')

// =========================================================================
// encryptToken / decryptToken
// =========================================================================

describe('encryptToken / decryptToken', () => {
  test('roundtrip recovers the exact token', () => {
    const token = 'canvas-pat-1234~AbCdEfGh'
    const blob = encryptToken(token, KEY)
    assert.equal(decryptToken(blob, KEY), token)
  })

  test('roundtrip survives unicode and long tokens', () => {
    const token = '令牌-ünïcode-'.repeat(20)
    assert.equal(decryptToken(encryptToken(token, KEY), KEY), token)
  })

  test('blob is iv.ciphertext.authTag — three base64 segments', () => {
    const blob = encryptToken('tok', KEY)
    const parts = blob.split('.')
    assert.equal(parts.length, 3)
    const [iv, ciphertext, authTag] = parts.map((p) => Buffer.from(p, 'base64'))
    assert.equal(iv.length, 12) // GCM nonce
    assert.equal(ciphertext.length, Buffer.byteLength('tok', 'utf8'))
    assert.equal(authTag.length, 16) // GCM tag
  })

  test('fresh IV per call: same token encrypts to different blobs', () => {
    const a = encryptToken('same-token', KEY)
    const b = encryptToken('same-token', KEY)
    assert.notEqual(a, b)
    assert.equal(decryptToken(a, KEY), decryptToken(b, KEY))
  })

  test('tamper detection: flipping a ciphertext byte throws', () => {
    const blob = encryptToken('super-secret-canvas-token', KEY)
    const parts = blob.split('.')
    const ciphertext = Buffer.from(parts[1], 'base64')
    ciphertext[0] ^= 0xff // flip a byte
    const tampered = [parts[0], ciphertext.toString('base64'), parts[2]].join('.')
    assert.throws(() => decryptToken(tampered, KEY))
  })

  test('tamper detection: flipping an auth-tag byte throws', () => {
    const blob = encryptToken('super-secret-canvas-token', KEY)
    const parts = blob.split('.')
    const authTag = Buffer.from(parts[2], 'base64')
    authTag[3] ^= 0x01
    const tampered = [parts[0], parts[1], authTag.toString('base64')].join('.')
    assert.throws(() => decryptToken(tampered, KEY))
  })

  test('decrypting with a different (valid-length) key throws', () => {
    const blob = encryptToken('tok', KEY)
    assert.throws(() => decryptToken(blob, OTHER_KEY))
  })

  test('invalid key length: error names CANVAS_TOKEN_KEY', () => {
    const shortKey = Buffer.alloc(16, 1).toString('base64')
    for (const badKey of ['', 'not-base64!!!', shortKey]) {
      assert.throws(() => encryptToken('tok', badKey), /CANVAS_TOKEN_KEY/)
      assert.throws(() => decryptToken('a.b.c', badKey), /CANVAS_TOKEN_KEY/)
    }
  })

  test('malformed blob (wrong segment count) throws', () => {
    assert.throws(() => decryptToken('only.two', KEY))
    assert.throws(() => decryptToken('', KEY))
  })
})

// =========================================================================
// mapAssignmentsToTasks
// =========================================================================

describe('mapAssignmentsToTasks', () => {
  const NOW = Date.parse('2026-09-15T12:00:00.000Z')
  const DAY = 86_400_000

  const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

  test('maps the pinned tasks-row shape', () => {
    const rows = mapAssignmentsToTasks(
      [{ id: 42, name: 'PS3: Dynamic Programming', due_at: iso(3 * DAY), points_possible: 10 }],
      NOW
    )
    assert.equal(rows.length, 1)
    assert.deepEqual(rows[0], {
      source: 'canvas',
      source_ref: '42',
      title: 'PS3: Dynamic Programming',
      estimated_minutes: 60, // 10 * 6
      intensity: 2, // < 20 points
      due_at: iso(3 * DAY),
      status: 'pending',
    })
  })

  test('source_ref is String(assignment.id), including string ids', () => {
    const rows = mapAssignmentsToTasks(
      [
        { id: 7, name: 'A', due_at: iso(DAY) },
        { id: 'abc-123', name: 'B', due_at: iso(DAY) },
      ],
      NOW
    )
    assert.deepEqual(rows.map((r) => r.source_ref), ['7', 'abc-123'])
  })

  test('estimated_minutes = clamp(points * 6, 30, 240); no points => 60', () => {
    const est = (points_possible: number | null | undefined) =>
      mapAssignmentsToTasks([{ id: 1, name: 'x', due_at: iso(DAY), points_possible }], NOW)[0]
        .estimated_minutes
    assert.equal(est(2), 30) // 12 clamps up to 30
    assert.equal(est(5), 30) // exactly 30
    assert.equal(est(10), 60)
    assert.equal(est(25), 150)
    assert.equal(est(40), 240) // exactly 240
    assert.equal(est(100), 240) // 600 clamps down to 240
    assert.equal(est(null), 60)
    assert.equal(est(undefined), 60)
    assert.equal(est(0), 60)
  })

  test('intensity heuristic 2-4 by points; unknown => 3', () => {
    const intensity = (points_possible: number | null | undefined) =>
      mapAssignmentsToTasks([{ id: 1, name: 'x', due_at: iso(DAY), points_possible }], NOW)[0]
        .intensity
    assert.equal(intensity(5), 2)
    assert.equal(intensity(19), 2)
    assert.equal(intensity(20), 3)
    assert.equal(intensity(99), 3)
    assert.equal(intensity(100), 4)
    assert.equal(intensity(250), 4)
    assert.equal(intensity(null), 3)
    assert.equal(intensity(0), 3)
  })

  test('skips assignments without an id', () => {
    const rows = mapAssignmentsToTasks(
      [
        { name: 'no id', due_at: iso(DAY) },
        { id: null, name: 'null id', due_at: iso(DAY) },
        { id: '', name: 'empty id', due_at: iso(DAY) },
        { id: 1, name: 'kept', due_at: iso(DAY) },
      ],
      NOW
    )
    assert.deepEqual(rows.map((r) => r.title), ['kept'])
  })

  test('skips assignments past due by more than 1 day', () => {
    const rows = mapAssignmentsToTasks(
      [
        { id: 1, name: 'ancient', due_at: iso(-2 * DAY) },
        { id: 2, name: 'just over', due_at: iso(-DAY - 1) },
        { id: 3, name: 'yesterday-ish (kept)', due_at: iso(-DAY + 60_000) },
        { id: 4, name: 'future (kept)', due_at: iso(DAY) },
      ],
      NOW
    )
    assert.deepEqual(rows.map((r) => r.source_ref), ['3', '4'])
  })

  test('no due date is kept with due_at null (engine treats as 14 days out)', () => {
    const rows = mapAssignmentsToTasks([{ id: 9, name: 'open-ended', points_possible: 50 }], NOW)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].due_at, null)
  })

  test('unparseable due_at is skipped', () => {
    const rows = mapAssignmentsToTasks(
      [{ id: 1, name: 'bad date', due_at: 'not-a-date' }],
      NOW
    )
    assert.equal(rows.length, 0)
  })

  test('due_at is normalized to ISO 8601 UTC', () => {
    const rows = mapAssignmentsToTasks(
      [{ id: 1, name: 'tz', due_at: '2026-09-20T20:00:00-04:00' }],
      NOW
    )
    assert.equal(rows[0].due_at, '2026-09-21T00:00:00.000Z')
  })

  test('missing name falls back to a placeholder title', () => {
    const rows = mapAssignmentsToTasks([{ id: 1, due_at: iso(DAY) }], NOW)
    assert.equal(rows[0].title, 'Untitled assignment')
  })

  test('empty and missing input yield no rows', () => {
    assert.deepEqual(mapAssignmentsToTasks([], NOW), [])
    assert.deepEqual(mapAssignmentsToTasks(undefined as unknown as CanvasAssignment[], NOW), [])
  })
})
