/**
 * Daily cron — pinned W1 ROUTE contract (GET /api/cron/daily):
 *   1) SOC catalog sync for the active term (lib/socCatalog.ts syncCatalog),
 *   2) self-call POST {SELF_BASE_URL}/api/scheduler/cron/daily-plan with the
 *      same CRON_SECRET Bearer, so plan generation runs in its own serverless
 *      invocation with its own time budget.
 *
 * Either half can fail without aborting the other: each outcome is reported
 * independently in the response body and nothing here ever throws the whole
 * run. Guard + GET/POST registration follow routes/seatwatch.ts cronPoll
 * (Vercel Cron invokes with GET and sends `Authorization: Bearer
 * $CRON_SECRET` automatically; POST is kept for manual/ops triggering).
 *
 * PRIVACY (DEV-SPEC hard rule): this route logs and returns counts/timings
 * only — never schedule details, self-report values, or contact info. The
 * relayed daily-plan body is itself counts-only ({date, users, planned,
 * errors}).
 *
 * Env:
 *   CRON_SECRET   — Bearer guard, also forwarded on the self-call.
 *   SELF_BASE_URL — overrides the production host for the self-call
 *                   (e.g. a preview deployment URL).
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { syncCatalog } from '../lib/socCatalog.js'

export const dailyCronRoutes = new Hono()

const DEFAULT_SELF_BASE_URL = 'https://class-mate-web-d1vc.vercel.app'
// Self-call ceiling: below Vercel's 60s function cap so a hung downstream
// never turns this half into an unreported platform timeout.
const SELF_CALL_TIMEOUT_MS = 55_000

interface HalfResult {
  ok: boolean
  [key: string]: unknown
}

const dailyCron = async (c: Context) => {
  const secret = process.env.CRON_SECRET
  const auth = c.req.header('authorization') || ''
  if (!secret || auth !== `Bearer ${secret}`) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }

  const t0 = Date.now()

  // ---- half 1: SOC catalog sync (DEV-SPEC §5 daily 04:00 full sync) -------
  let catalog: HalfResult
  try {
    catalog = { ok: true, ...(await syncCatalog()) }
  } catch (error: any) {
    console.error('Daily cron: catalog sync failed:', error)
    catalog = { ok: false, error: error?.message || 'catalog sync failed' }
  }

  // ---- half 2: self-call the scheduler daily-plan cron ---------------------
  let dailyPlan: HalfResult
  try {
    const base = (process.env.SELF_BASE_URL || DEFAULT_SELF_BASE_URL).replace(/\/+$/, '')
    const response = await fetch(`${base}/api/scheduler/cron/daily-plan`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(SELF_CALL_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => null)
    dailyPlan = response.ok
      ? { ok: true, status: response.status, result: body }
      : {
          ok: false,
          status: response.status,
          error: `daily-plan self-call returned ${response.status}`,
          result: body,
        }
  } catch (error: any) {
    console.error('Daily cron: daily-plan self-call failed:', error)
    dailyPlan = { ok: false, error: error?.message || 'daily-plan self-call failed' }
  }

  // Overall success only when both halves landed; a 500 keeps the failed run
  // visible on the Vercel cron dashboard while the body says which half broke.
  const success = catalog.ok && dailyPlan.ok
  return c.json({ success, catalog, dailyPlan, ms: Date.now() - t0 }, success ? 200 : 500)
}

dailyCronRoutes.get('/', dailyCron)
dailyCronRoutes.post('/', dailyCron)
