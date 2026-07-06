/**
 * Canvas LMS integration — PRODUCT-V1 §3.1 source #2 (assignments/deadlines).
 *
 * File layout (house pattern, see lib/webreg.ts):
 *   1. PURE section — token encryption/decryption and assignment->task
 *      mapping. No env access, no supabase import, no network.
 *      apps/api/tests/canvas.test.ts imports ONLY these exports, so this
 *      module must stay import-safe without any environment configured.
 *   2. IO section — Canvas REST calls and the sync pipeline. The supabase
 *      service client is imported lazily inside the IO functions so merely
 *      importing this module never touches SUPABASE_* env vars. Env is read
 *      at call time, never at module load.
 *
 * PRIVACY RED LINES (PRODUCT-V1 §7.3):
 *   - Canvas tokens are encrypted at rest with AES-256-GCM under
 *     CANVAS_TOKEN_KEY and are NEVER returned by any endpoint. Nothing in
 *     this module ever logs or returns a plaintext token or the encrypted
 *     blob; callers must not either.
 *   - Disconnecting deletes derived data (pending/scheduled canvas tasks);
 *     see routes/canvas.ts DELETE /disconnect.
 *
 * Env (IO section only, read at call time):
 *   CANVAS_TOKEN_KEY — 32 random bytes, base64-encoded (generate with
 *                      `openssl rand -base64 32`). Required for connect/sync.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// =========================================================================
// 1. PURE — token encryption (AES-256-GCM)
// =========================================================================

/**
 * Decode and validate the encryption key. The error message deliberately
 * names CANVAS_TOKEN_KEY so a misconfigured deploy is diagnosable from logs
 * without printing any key material.
 */
function keyFromB64(keyB64: string): Buffer {
  const key = keyB64 ? Buffer.from(keyB64, 'base64') : Buffer.alloc(0)
  if (key.length !== 32) {
    throw new Error(
      'CANVAS_TOKEN_KEY must be 32 random bytes base64-encoded (generate with `openssl rand -base64 32`)'
    )
  }
  return key
}

/**
 * Encrypt a Canvas API token for storage.
 * Blob format: "iv.ciphertext.authTag" — three base64 segments joined with
 * dots. A fresh 12-byte IV is generated per call, so encrypting the same
 * token twice yields different blobs.
 */
export function encryptToken(plain: string, keyB64: string): string {
  const key = keyFromB64(keyB64)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [iv.toString('base64'), ciphertext.toString('base64'), authTag.toString('base64')].join('.')
}

/**
 * Decrypt a stored token blob. Throws on a malformed blob, a wrong key, or
 * any tampering (GCM auth tag verification fails in `final()`).
 */
export function decryptToken(blob: string, keyB64: string): string {
  const key = keyFromB64(keyB64)
  const parts = (blob || '').split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid canvas token blob (expected iv.ciphertext.authTag)')
  }
  const [iv, ciphertext, authTag] = parts.map((part) => Buffer.from(part, 'base64'))
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

// =========================================================================
// 1. PURE — assignment -> task mapping
// =========================================================================

/** The slice of a Canvas assignment object this module cares about. */
export interface CanvasAssignment {
  id?: number | string | null
  name?: string | null
  due_at?: string | null
  points_possible?: number | null
}

/** Pinned tasks-row shape (minus user_id, which the IO layer stamps). */
export interface CanvasTaskRow {
  source: 'canvas'
  source_ref: string
  title: string
  estimated_minutes: number
  intensity: number
  due_at: string | null
  status: 'pending'
}

const DAY_MS = 86_400_000

/** clamp(points * 6, 30, 240) minutes; no/zero points => 60. */
function estimateMinutes(points: number | null | undefined): number {
  if (!points || points <= 0) return 60
  return Math.min(240, Math.max(30, points * 6))
}

/** Intensity heuristic 2-4 by points: <20 => 2, <100 => 3, >=100 => 4. */
function estimateIntensity(points: number | null | undefined): number {
  if (!points || points <= 0) return 3 // unknown weight -> table default
  if (points < 20) return 2
  if (points < 100) return 3
  return 4
}

/**
 * Map Canvas assignment JSON to pinned tasks-row shapes (source 'canvas',
 * source_ref = String(assignment.id)). Skips assignments without an id and
 * assignments already past due by more than 1 day (nothing actionable to
 * schedule). Assignments with no due date are kept (due_at null — the
 * engine treats them as 14 days out).
 */
export function mapAssignmentsToTasks(
  assignments: CanvasAssignment[],
  nowMs: number
): CanvasTaskRow[] {
  const rows: CanvasTaskRow[] = []
  for (const assignment of assignments || []) {
    if (assignment?.id === null || assignment?.id === undefined || assignment.id === '') continue

    let dueAt: string | null = null
    if (assignment.due_at) {
      const dueMs = Date.parse(assignment.due_at)
      if (Number.isNaN(dueMs)) continue
      if (dueMs < nowMs - DAY_MS) continue // past due by >1 day
      dueAt = new Date(dueMs).toISOString()
    }

    rows.push({
      source: 'canvas',
      source_ref: String(assignment.id),
      title: assignment.name || 'Untitled assignment',
      estimated_minutes: estimateMinutes(assignment.points_possible),
      intensity: estimateIntensity(assignment.points_possible),
      due_at: dueAt,
      status: 'pending',
    })
  }
  return rows
}

// =========================================================================
// 2. IO — Canvas REST access
// =========================================================================

export const DEFAULT_CANVAS_BASE_URL = 'https://rutgers.instructure.com'
const FETCH_TIMEOUT_MS = 8_000

// Lazy so importing this module (e.g. from tests) never needs SUPABASE_* env.
type SupabaseClient = (typeof import('./supabase.js'))['supabase']
let dbPromise: Promise<SupabaseClient> | null = null
function getDb(): Promise<SupabaseClient> {
  if (!dbPromise) dbPromise = import('./supabase.js').then((m) => m.supabase)
  return dbPromise
}

/**
 * GET a Canvas REST path with Bearer auth, per_page=50, and an 8s timeout.
 * `path` starts with /api/v1/... and may already carry query params.
 * The token is used for the Authorization header only — never logged.
 */
export async function canvasFetch<T = unknown>(
  baseUrl: string,
  token: string,
  path: string
): Promise<T> {
  const base = (baseUrl || DEFAULT_CANVAS_BASE_URL).replace(/\/+$/, '')
  const sep = path.includes('?') ? '&' : '?'
  const response = await fetch(`${base}${path}${sep}per_page=50`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) {
    // Status only — never echo the URL's host with credentials or the token.
    throw new Error(`Canvas responded ${response.status} for ${path.split('?')[0]}`)
  }
  return (await response.json()) as T
}

/** True when the token can read the current user (/api/v1/users/self). */
export async function verifyToken(baseUrl: string, token: string): Promise<boolean> {
  try {
    await canvasFetch(baseUrl, token, '/api/v1/users/self')
    return true
  } catch {
    return false
  }
}

// =========================================================================
// 2. IO — sync pipeline
// =========================================================================

interface CanvasCourse {
  id?: number | string | null
}

export interface CanvasSyncSummary {
  coursesChecked: number
  courseErrors: number
  inserted: number
  updated: number
}

/**
 * Pull upcoming assignments for every active course and upsert them into
 * `tasks`, deduped on the partial unique (user_id, source, source_ref).
 *
 * The dedupe is done as select-then-insert/update rather than a PostgREST
 * .upsert(): ON CONFLICT cannot infer a *partial* unique index without a
 * WHERE clause PostgREST does not emit, and a blind upsert would also clobber
 * `status` — a task the user already scheduled/completed/dropped must keep
 * its status; only the Canvas-owned metadata (title, estimate, intensity,
 * due_at) is refreshed.
 *
 * Always stamps canvas_connections.last_synced_at / sync_error on the way
 * out. Never returns or logs token material.
 */
export async function syncCanvasTasks(userId: string): Promise<CanvasSyncSummary> {
  const db = await getDb()

  const { data: conn, error: connError } = await db
    .from('canvas_connections')
    .select('user_id, base_url, token_encrypted') // token stays server-side
    .eq('user_id', userId)
    .maybeSingle()
  if (connError) throw connError
  if (!conn) throw new Error('Canvas is not connected')

  const stamp = async (syncError: string | null) => {
    await db
      .from('canvas_connections')
      .update({
        last_synced_at: new Date().toISOString(),
        sync_error: syncError ? syncError.slice(0, 500) : null,
      })
      .eq('user_id', userId)
  }

  const summary: CanvasSyncSummary = {
    coursesChecked: 0,
    courseErrors: 0,
    inserted: 0,
    updated: 0,
  }

  try {
    const token = decryptToken(conn.token_encrypted, process.env.CANVAS_TOKEN_KEY || '')
    const baseUrl = conn.base_url || DEFAULT_CANVAS_BASE_URL

    const courses = await canvasFetch<CanvasCourse[]>(
      baseUrl,
      token,
      '/api/v1/courses?enrollment_state=active'
    )

    const nowMs = Date.now()
    const rowByRef = new Map<string, CanvasTaskRow>()
    for (const course of Array.isArray(courses) ? courses : []) {
      if (course?.id === null || course?.id === undefined) continue
      try {
        const assignments = await canvasFetch<CanvasAssignment[]>(
          baseUrl,
          token,
          `/api/v1/courses/${course.id}/assignments?bucket=upcoming`
        )
        summary.coursesChecked += 1
        for (const row of mapAssignmentsToTasks(
          Array.isArray(assignments) ? assignments : [],
          nowMs
        )) {
          rowByRef.set(row.source_ref, row)
        }
      } catch (err) {
        // One unreadable course (e.g. restricted) must not sink the sync.
        console.error(`Canvas sync: course ${course.id} failed:`, err)
        summary.courseErrors += 1
      }
    }

    const refs = Array.from(rowByRef.keys())
    const existingByRef = new Map<string, string>() // source_ref -> task id
    if (refs.length > 0) {
      const { data: existing, error: existingError } = await db
        .from('tasks')
        .select('id, source_ref')
        .eq('user_id', userId)
        .eq('source', 'canvas')
        .in('source_ref', refs)
      if (existingError) throw existingError
      for (const task of (existing as { id: string; source_ref: string }[]) || []) {
        existingByRef.set(task.source_ref, task.id)
      }
    }

    const inserts = refs
      .filter((ref) => !existingByRef.has(ref))
      .map((ref) => ({ user_id: userId, ...rowByRef.get(ref)! }))
    if (inserts.length > 0) {
      const { error: insertError } = await db.from('tasks').insert(inserts)
      if (insertError) throw insertError
      summary.inserted = inserts.length
    }

    for (const [ref, taskId] of existingByRef) {
      const row = rowByRef.get(ref)!
      const { error: updateError } = await db
        .from('tasks')
        .update({
          // Canvas-owned metadata only — status/completed_at belong to the user.
          title: row.title,
          estimated_minutes: row.estimated_minutes,
          intensity: row.intensity,
          due_at: row.due_at,
        })
        .eq('id', taskId)
        .eq('user_id', userId)
      if (updateError) throw updateError
      summary.updated += 1
    }

    await stamp(
      summary.courseErrors > 0
        ? `${summary.courseErrors} course(s) could not be synced`
        : null
    )
    return summary
  } catch (error: any) {
    await stamp(error?.message || 'Canvas sync failed')
    throw error
  }
}
