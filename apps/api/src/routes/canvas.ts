/**
 * Canvas connection routes — PRODUCT-V1 §3.1 source #2, §7.3 privacy.
 *
 * PRIVACY RED LINES (PRODUCT-V1 §7.3):
 *   - The Canvas token is accepted ONCE on POST /connect, verified, encrypted
 *     (AES-256-GCM under CANVAS_TOKEN_KEY) and stored. No endpoint here — or
 *     anywhere — ever returns the token or the encrypted blob; every select
 *     on canvas_connections enumerates columns and excludes token_encrypted.
 *   - DELETE /disconnect deletes the connection AND the derived data
 *     (pending/scheduled canvas tasks). Completed history stays — it is the
 *     user's own record, not Canvas-derived state anyone else can see.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import { supabase } from '../lib/supabase.js'
import { requireAuth } from '../middleware/auth.js'
import {
  DEFAULT_CANVAS_BASE_URL,
  encryptToken,
  verifyToken,
  syncCanvasTasks,
} from '../lib/canvas.js'
import type { AppVariables } from '../types.js'

export const canvasRoutes = new Hono<{ Variables: AppVariables }>()

const errorStatus = (error: unknown) => (error instanceof z.ZodError ? 400 : 500)
const errorMessage = (error: any) =>
  error instanceof z.ZodError
    ? error.errors[0]?.message || 'Invalid input'
    : error?.message || 'Unexpected error'

/** Minimum gap between syncs (POST /sync guard). */
const SYNC_COOLDOWN_MS = 5 * 60_000

// ---------------------------------------------------------------- connect
const connectSchema = z.object({
  token: z.string().min(1).max(500),
  baseUrl: z.string().url().optional(),
})

canvasRoutes.post('/connect', requireAuth, async (c) => {
  try {
    const user = c.get('user')
    const { token, baseUrl } = connectSchema.parse(await c.req.json())
    const base = (baseUrl || DEFAULT_CANVAS_BASE_URL).replace(/\/+$/, '')

    // Verify against Canvas before storing anything.
    const valid = await verifyToken(base, token)
    if (!valid) {
      return c.json(
        { success: false, error: 'Canvas rejected that token — check it and try again' },
        400
      )
    }

    // Encrypted at rest; throws a CANVAS_TOKEN_KEY-naming error when the key
    // env is missing/invalid (deploy misconfiguration, not user error).
    const blob = encryptToken(token, process.env.CANVAS_TOKEN_KEY || '')

    const { error } = await supabase.from('canvas_connections').upsert(
      {
        user_id: user.id,
        base_url: base,
        token_encrypted: blob,
        connected_at: new Date().toISOString(),
        last_synced_at: null,
        sync_error: null,
      },
      { onConflict: 'user_id' }
    )
    if (error) throw error

    // First sync, fired inline. A sync failure must not fail the connect —
    // the token is verified and stored; sync_error is stamped on the row.
    let sync = null
    try {
      sync = await syncCanvasTasks(user.id)
    } catch (syncError) {
      console.error('Canvas initial sync failed:', syncError)
    }

    // NEVER echo the token (or its encrypted form) back.
    return c.json({ success: true, connected: true, base_url: base, sync })
  } catch (error: any) {
    console.error('Canvas connect error:', error)
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error))
  }
})

// ---------------------------------------------------------------- status
canvasRoutes.get('/status', requireAuth, async (c) => {
  try {
    const user = c.get('user')

    // Columns enumerated on purpose: token_encrypted must NEVER be selected
    // into a response (PRODUCT-V1 §7.3).
    const { data: conn, error } = await supabase
      .from('canvas_connections')
      .select('base_url, connected_at, last_synced_at, sync_error')
      .eq('user_id', user.id)
      .maybeSingle()
    if (error) throw error

    if (!conn) {
      return c.json({ success: true, connected: false })
    }

    const { count, error: countError } = await supabase
      .from('tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .eq('source', 'canvas')
    if (countError) throw countError

    return c.json({
      success: true,
      connected: true,
      base_url: conn.base_url,
      connected_at: conn.connected_at,
      last_synced_at: conn.last_synced_at,
      sync_error: conn.sync_error,
      task_count: count || 0,
    })
  } catch (error: any) {
    console.error('Canvas status error:', error)
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error))
  }
})

// ---------------------------------------------------------------- sync
canvasRoutes.post('/sync', requireAuth, async (c) => {
  try {
    const user = c.get('user')

    const { data: conn, error } = await supabase
      .from('canvas_connections')
      .select('last_synced_at') // never token_encrypted
      .eq('user_id', user.id)
      .maybeSingle()
    if (error) throw error
    if (!conn) {
      return c.json({ success: false, error: 'Canvas is not connected' }, 400)
    }

    // 429-style guard: Canvas rate limits are real and assignments do not
    // change minute-to-minute.
    if (conn.last_synced_at && Date.now() - Date.parse(conn.last_synced_at) < SYNC_COOLDOWN_MS) {
      return c.json(
        { success: false, error: 'Synced less than 5 minutes ago — try again shortly' },
        429
      )
    }

    const sync = await syncCanvasTasks(user.id)
    return c.json({ success: true, sync })
  } catch (error: any) {
    console.error('Canvas sync error:', error)
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error))
  }
})

// ---------------------------------------------------------------- disconnect
canvasRoutes.delete('/disconnect', requireAuth, async (c) => {
  try {
    const user = c.get('user')

    // §7.3 "disconnect deletes derived data": pending/scheduled canvas tasks
    // are Canvas-derived and go with the connection. Completed (and dropped)
    // history stays. schedule_blocks referencing a deleted task fall back to
    // task_id null (FK on delete set null).
    const { count, error: taskError } = await supabase
      .from('tasks')
      .delete({ count: 'exact' })
      .eq('user_id', user.id)
      .eq('source', 'canvas')
      .in('status', ['pending', 'scheduled'])
    if (taskError) throw taskError

    const { error: connError } = await supabase
      .from('canvas_connections')
      .delete()
      .eq('user_id', user.id)
    if (connError) throw connError

    return c.json({ success: true, connected: false, removed_tasks: count || 0 })
  } catch (error: any) {
    console.error('Canvas disconnect error:', error)
    return c.json({ success: false, error: errorMessage(error) }, errorStatus(error))
  }
})
