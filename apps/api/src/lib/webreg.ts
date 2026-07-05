/**
 * WebReg (Rutgers SOC) resilient adapter — NEXT-STEPS P1 #5.
 *
 * File layout:
 *   1. PURE section — backoff + circuit-breaker transition functions and
 *      semester-id helpers. No env access, no supabase import, no network.
 *      apps/api/tests/webreg.test.ts imports ONLY these exports, so this
 *      module must stay import-safe without any environment configured.
 *   2. IO section — SOC openSections fetch, webreg_health persistence, and
 *      pollWatches() (the cron entry point). The supabase service client is
 *      imported lazily inside the IO functions so merely importing this
 *      module never touches SUPABASE_* env vars.
 *
 * Env (IO section only, read at call time):
 *   WEBREG_BASE_URL    — override the SOC API base
 *                        (default https://classes.rutgers.edu/soc/api,
 *                        same host as lib/rutgers.ts).
 *   WEBREG_PROXY_URLS  — optional comma-separated list of relay base URLs
 *                        rotated round-robin per request. This is the
 *                        IP-rotation strategy hook: on Vercel serverless it is
 *                        normally unnecessary because egress IPs already
 *                        rotate naturally across invocations/regions, so the
 *                        registrar never sees one hot address. If the SOC
 *                        endpoint ever blocks the platform ASN, deploy thin
 *                        relays (same path shape as the SOC API) elsewhere and
 *                        list them here.
 */

// =========================================================================
// 1. PURE — backoff
// =========================================================================

/**
 * Exponential backoff with full jitter.
 * raw = min(capMs, baseMs * 2^attempt); returns floor(jitterFn() * raw),
 * i.e. uniform in [0, raw) for jitterFn = Math.random.
 * attempt is 0-based (attempt 0 => raw = baseMs).
 */
export function computeBackoffMs(
  attempt: number,
  baseMs = 2_000,
  capMs = 300_000,
  jitterFn: () => number = Math.random
): number {
  const raw = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  return Math.floor(jitterFn() * raw)
}

// =========================================================================
// 1. PURE — circuit breaker
// =========================================================================

export type BreakerStateName = 'closed' | 'open' | 'half_open'
export type BreakerEvent = 'ok' | 'fail'

export interface BreakerState {
  state: BreakerStateName
  consecutiveFailures: number
  /** Epoch ms of the most recent transition to `open` (cooldown anchor). */
  openedAt: number | null
}

export interface BreakerOptions {
  /** Consecutive failures (while closed) that trip the breaker. Default 5. */
  failureThreshold?: number
  /** How long the breaker stays open before allowing a probe. Default 10 min. */
  openCooldownMs?: number
}

export const BREAKER_DEFAULTS = {
  failureThreshold: 5,
  openCooldownMs: 600_000,
} as const

export function initialBreakerState(): BreakerState {
  return { state: 'closed', consecutiveFailures: 0, openedAt: null }
}

/**
 * open -> half_open once the cooldown has elapsed; all other states pass
 * through unchanged. Pure: `now` is epoch ms supplied by the caller.
 */
export function promoteIfCooldownExpired(
  state: BreakerState,
  now: number,
  opts: BreakerOptions = {}
): BreakerState {
  const openCooldownMs = opts.openCooldownMs ?? BREAKER_DEFAULTS.openCooldownMs
  if (
    state.state === 'open' &&
    state.openedAt !== null &&
    now - state.openedAt >= openCooldownMs
  ) {
    return { ...state, state: 'half_open' }
  }
  return state
}

/**
 * Pure transition function.
 *   closed + fail (below threshold)  -> closed, failures+1
 *   closed + fail (at threshold)     -> open, openedAt = now
 *   open (cooldown elapsed)          -> treated as half_open (auto-promote)
 *   half_open + ok                   -> closed, failures reset
 *   half_open + fail                 -> open, fresh cooldown anchor (openedAt = now)
 *   any + ok                         -> closed (a success always heals)
 */
export function nextBreakerState(
  state: BreakerState,
  event: BreakerEvent,
  now: number,
  opts: BreakerOptions = {}
): BreakerState {
  const failureThreshold = opts.failureThreshold ?? BREAKER_DEFAULTS.failureThreshold
  const current = promoteIfCooldownExpired(state, now, opts)

  if (event === 'ok') {
    return { state: 'closed', consecutiveFailures: 0, openedAt: null }
  }

  switch (current.state) {
    case 'half_open':
      // Failed probe: re-open with a fresh cooldown anchor.
      return {
        state: 'open',
        consecutiveFailures: current.consecutiveFailures + 1,
        openedAt: now,
      }
    case 'open':
      // Failure while already open (callers normally skip): stay open,
      // keep the existing cooldown anchor.
      return { ...current, consecutiveFailures: current.consecutiveFailures + 1 }
    case 'closed': {
      const failures = current.consecutiveFailures + 1
      if (failures >= failureThreshold) {
        return { state: 'open', consecutiveFailures: failures, openedAt: now }
      }
      return { state: 'closed', consecutiveFailures: failures, openedAt: null }
    }
  }
}

/**
 * True when a request may be attempted: closed, half_open, or open with an
 * expired cooldown (which counts as the half-open probe).
 */
export function breakerAllowsRequest(
  state: BreakerState,
  now: number,
  opts: BreakerOptions = {}
): boolean {
  return promoteIfCooldownExpired(state, now, opts).state !== 'open'
}

// =========================================================================
// 1. PURE — semester ids (server-side mirror of apps/web/src/lib/semester.ts)
// =========================================================================

const TERM_BY_NAME: Record<string, number> = { spring: 1, fall: 7, summer: 9, winter: 0 }

/** "2026-fall" -> { year: 2026, term: 7 } (Rutgers term codes), or null. */
export function parseSemesterId(semester: string): { year: number; term: number } | null {
  const parts = semester.split('-')
  if (parts.length !== 2) return null
  const year = parseInt(parts[0], 10)
  const term = TERM_BY_NAME[parts[1].toLowerCase()]
  if (!year || term === undefined) return null
  return { year, term }
}

/** Current semester id, e.g. "2026-fall". Month buckets match the web app. */
export function getCurrentSemesterId(now: Date = new Date()): string {
  const month = now.getMonth() // 0-indexed
  const year = now.getFullYear()
  const termName = month <= 4 ? 'spring' : month <= 6 ? 'summer' : 'fall'
  return `${year}-${termName}`
}

// =========================================================================
// 2. IO — SOC access
// =========================================================================

const DEFAULT_BASE_URL = 'https://classes.rutgers.edu/soc/api'
const FETCH_TIMEOUT_MS = 8_000
const FETCH_MAX_ATTEMPTS = 2 // per poll run; cross-run backoff is the breaker cooldown

let proxyCursor = 0

/** Pick the base URL for this request (round-robin over WEBREG_PROXY_URLS). */
function pickBaseUrl(): string {
  const proxies = (process.env.WEBREG_PROXY_URLS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (proxies.length > 0) {
    const base = proxies[proxyCursor % proxies.length]
    proxyCursor += 1
    return base
  }
  return process.env.WEBREG_BASE_URL || DEFAULT_BASE_URL
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fetch the set of currently-open section indexes for a semester.
 * One request covers every section in the term, so the poller makes a single
 * SOC call per semester group regardless of how many watches exist.
 */
export async function fetchOpenSections(
  semester: string,
  campus = 'NB'
): Promise<Set<string>> {
  const parsed = parseSemesterId(semester)
  if (!parsed) throw new Error(`Invalid semester id: ${semester}`)

  let lastError: unknown = null
  for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
    const url = `${pickBaseUrl()}/openSections.json?year=${parsed.year}&term=${parsed.term}&campus=${campus}`
    try {
      const response = await fetch(url, {
        headers: {
          'Accept-Encoding': 'gzip, deflate',
          'User-Agent': 'ClassMate/1.0',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`openSections ${response.status} for ${semester}`)
      }
      const data = await response.json()
      if (!Array.isArray(data)) {
        throw new Error(`openSections returned non-array for ${semester}`)
      }
      return new Set<string>(data.map(String))
    } catch (err) {
      lastError = err
      if (attempt < FETCH_MAX_ATTEMPTS - 1) {
        // Small in-request retry; keep well inside the serverless time budget.
        await sleep(computeBackoffMs(attempt, 1_000, 8_000))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Live check for a single section (spec entry point). */
export async function checkSectionOpen(index: string, semester: string): Promise<boolean> {
  const open = await fetchOpenSections(semester)
  return open.has(index)
}

// =========================================================================
// 2. IO — health persistence (webreg_health row id=1)
// =========================================================================

// Lazy so importing this module (e.g. from tests) never needs SUPABASE_* env.
type SupabaseClient = (typeof import('./supabase.js'))['supabase']
let dbPromise: Promise<SupabaseClient> | null = null
function getDb(): Promise<SupabaseClient> {
  if (!dbPromise) dbPromise = import('./supabase.js').then((m) => m.supabase)
  return dbPromise
}

export interface WebregHealth {
  breaker: BreakerState
  lastOkAt: string | null
  degradedIcsOnly: boolean
}

export async function loadHealth(): Promise<WebregHealth> {
  const db = await getDb()
  const { data, error } = await db
    .from('webreg_health')
    .select('*')
    .eq('id', 1)
    .maybeSingle()
  if (error) throw error
  if (!data) {
    const fresh: WebregHealth = {
      breaker: initialBreakerState(),
      lastOkAt: null,
      degradedIcsOnly: false,
    }
    await saveHealth(fresh)
    return fresh
  }
  return {
    breaker: {
      state: (data.state as BreakerStateName) || 'closed',
      consecutiveFailures: data.consecutive_failures || 0,
      openedAt: data.opened_at ? Date.parse(data.opened_at) : null,
    },
    lastOkAt: data.last_ok_at || null,
    degradedIcsOnly: !!data.degraded_ics_only,
  }
}

export async function saveHealth(health: WebregHealth): Promise<void> {
  const db = await getDb()
  const { error } = await db.from('webreg_health').upsert({
    id: 1,
    state: health.breaker.state,
    consecutive_failures: health.breaker.consecutiveFailures,
    last_ok_at: health.lastOkAt,
    opened_at: health.breaker.openedAt
      ? new Date(health.breaker.openedAt).toISOString()
      : null,
    degraded_ics_only: health.degradedIcsOnly,
    updated_at: new Date().toISOString(),
  })
  if (error) throw error
}

export interface OutageRow {
  id: string
  started_at: string
  ended_at: string | null
  note: string | null
}

/** The currently-open outage window, if any (used by GET /health too). */
export async function getOpenOutage(): Promise<OutageRow | null> {
  const db = await getDb()
  const { data, error } = await db
    .from('seat_watch_outages')
    .select('*')
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .limit(1)
  if (error) throw error
  return ((data as OutageRow[]) || [])[0] || null
}

async function closeOpenOutages(endedAtIso: string): Promise<void> {
  const db = await getDb()
  const { error } = await db
    .from('seat_watch_outages')
    .update({ ended_at: endedAtIso })
    .is('ended_at', null)
  if (error) throw error
}

// =========================================================================
// 2. IO — poller
// =========================================================================

interface SeatWatchRow {
  id: string
  user_id: string
  section_index: string
  course_code: string | null
  semester: string
  status: 'open' | 'closed' | 'unknown'
  active: boolean
  last_checked_at: string | null
  notified_open_at: string | null
}

export interface PollSummary {
  skipped: boolean
  breaker: BreakerStateName
  degradedIcsOnly: boolean
  checked: number
  transitions: number
  alerts: number
  errors: number
}

/**
 * One poll pass (invoked by /api/seatwatch/cron/poll):
 *   - skips entirely while the breaker is open and cooling down;
 *   - otherwise takes the `batchSize` least-recently-checked active watches,
 *     groups them by semester, and makes ONE openSections call per group;
 *   - updates statuses, writes seat_watch_events on transitions, and stamps
 *     notified_open_at on closed->open (push delivery wiring lands with
 *     P1 #7 — this is the alert ledger until then);
 *   - records ok/fail into the breaker; opens an outage row when the breaker
 *     opens and closes outage rows on recovery;
 *   - flips degraded_ics_only=true once the registrar has been down for two
 *     full open-cooldown windows (cooldown expired twice with failing
 *     probes) — the product then stops promising live seat data and falls
 *     back to ICS-import-only flows; the flag clears on the first success.
 */
export async function pollWatches(batchSize = 30): Promise<PollSummary> {
  const db = await getDb()
  const nowMs = Date.now()
  const nowIso = new Date(nowMs).toISOString()

  const health = await loadHealth()
  let breaker = health.breaker
  let degraded = health.degradedIcsOnly
  let lastOkAt = health.lastOkAt

  if (!breakerAllowsRequest(breaker, nowMs)) {
    // Open and cooling down: no SOC traffic at all this run.
    return {
      skipped: true,
      breaker: breaker.state,
      degradedIcsOnly: degraded,
      checked: 0,
      transitions: 0,
      alerts: 0,
      errors: 0,
    }
  }

  const recordOk = async () => {
    const prev = promoteIfCooldownExpired(breaker, nowMs)
    breaker = nextBreakerState(breaker, 'ok', nowMs)
    lastOkAt = new Date().toISOString()
    if (prev.state !== 'closed') {
      // Recovery: clear degraded mode and close any open outage window.
      degraded = false
      await closeOpenOutages(lastOkAt)
    }
  }

  const recordFail = async () => {
    const prev = promoteIfCooldownExpired(breaker, nowMs)
    breaker = nextBreakerState(breaker, 'fail', nowMs)
    if (breaker.state === 'open' && prev.state !== 'open') {
      // Just opened: either the failure threshold tripped or a half-open
      // probe failed after a cooldown.
      const outage = await getOpenOutage()
      if (!outage) {
        await db.from('seat_watch_outages').insert({
          started_at: nowIso,
          note: 'WebReg/SOC unreachable — seat-watch breaker opened',
        })
      } else if (
        nowMs - Date.parse(outage.started_at) >=
        2 * BREAKER_DEFAULTS.openCooldownMs
      ) {
        // The open-cooldown has expired twice consecutively and probes still
        // fail -> ICS-only degraded mode.
        degraded = true
      }
    }
  }

  const { data, error } = await db
    .from('seat_watches')
    .select('*')
    .eq('active', true)
    .order('last_checked_at', { ascending: true, nullsFirst: true })
    .limit(batchSize)
  if (error) throw error
  const watches = (data as SeatWatchRow[]) || []

  const summary = { checked: 0, transitions: 0, alerts: 0, errors: 0 }

  // With no watches to piggyback on, still probe once when unhealthy so the
  // breaker can self-heal (otherwise health would stay open forever).
  if (watches.length === 0 && breaker.state !== 'closed') {
    try {
      await fetchOpenSections(getCurrentSemesterId())
      await recordOk()
    } catch (err) {
      console.error('Seat watch health probe failed:', err)
      await recordFail()
    }
  }

  const groups = new Map<string, SeatWatchRow[]>()
  for (const watch of watches) {
    const list = groups.get(watch.semester) || []
    list.push(watch)
    groups.set(watch.semester, list)
  }

  for (const [semester, group] of groups) {
    // A failing run can open the breaker mid-pass; stop generating traffic.
    if (!breakerAllowsRequest(breaker, nowMs)) break

    const parsed = parseSemesterId(semester)
    if (!parsed) {
      // Malformed semester on the row (permanent, not a registrar failure):
      // log an error event and rotate the rows to the back of the queue.
      summary.errors += group.length
      await db
        .from('seat_watch_events')
        .insert(group.map((w) => ({ watch_id: w.id, kind: 'error' })))
      await db
        .from('seat_watches')
        .update({ last_checked_at: nowIso })
        .in('id', group.map((w) => w.id))
      continue
    }

    let openSet: Set<string>
    try {
      openSet = await fetchOpenSections(semester)
      await recordOk()
    } catch (err) {
      console.error(`Seat watch poll failed for ${semester}:`, err)
      summary.errors += group.length
      await db
        .from('seat_watch_events')
        .insert(group.map((w) => ({ watch_id: w.id, kind: 'error' })))
      // last_checked_at intentionally untouched: failed rows stay at the
      // front of the queue and are retried first next run.
      await recordFail()
      continue
    }

    for (const watch of group) {
      const newStatus: SeatWatchRow['status'] = openSet.has(watch.section_index)
        ? 'open'
        : 'closed'
      const patch: Record<string, unknown> = {
        status: newStatus,
        last_checked_at: nowIso,
      }

      if (newStatus !== watch.status) {
        summary.transitions += 1
        await db
          .from('seat_watch_events')
          .insert({ watch_id: watch.id, kind: newStatus })

        if (watch.status === 'closed' && newStatus === 'open') {
          // The product's #1 moment. Push delivery wiring lands with P1 #7;
          // until then notified_open_at + the alert_sent event are the ledger.
          summary.alerts += 1
          patch.notified_open_at = nowIso
          await db
            .from('seat_watch_events')
            .insert({ watch_id: watch.id, kind: 'alert_sent' })
        }
      }

      const { error: updateError } = await db
        .from('seat_watches')
        .update(patch)
        .eq('id', watch.id)
      if (updateError) {
        console.error(`Seat watch update failed for ${watch.id}:`, updateError)
        summary.errors += 1
        continue
      }
      summary.checked += 1
    }
  }

  await saveHealth({ breaker, lastOkAt, degradedIcsOnly: degraded })

  return {
    skipped: false,
    breaker: breaker.state,
    degradedIcsOnly: degraded,
    ...summary,
  }
}
