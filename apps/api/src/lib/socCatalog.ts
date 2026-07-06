/**
 * SOC catalog sync — DEV-SPEC §5 (the daily part): full course-catalog sync
 * from the Rutgers SOC courses.json feed into the W1 catalog tables
 * (catalog_courses / catalog_sections / catalog_section_meetings).
 *
 * File layout (house pattern, see lib/webreg.ts):
 *   1. PURE section — SOC JSON -> catalog-row mapping (dow, military time,
 *      campus-slug normalization, course/section dedup) plus term-code
 *      helpers. No env access, no supabase import, no network.
 *      apps/api/tests/socCatalog.test.ts imports ONLY these exports, so this
 *      module must stay import-safe without any environment configured.
 *   2. IO section — courses.json fetch + chunked upserts. The supabase
 *      service client is imported lazily inside the IO functions so merely
 *      importing this module never touches SUPABASE_* env vars.
 *
 * PRIVACY (DEV-SPEC hard rule): logs carry counts and timing ONLY — never
 * course titles, meeting times, or any other schedule contents.
 *
 * Env (IO section only, read at call time):
 *   WEBREG_BASE_URL — override the SOC API base
 *                     (default https://classes.rutgers.edu/soc/api, same as
 *                     lib/webreg.ts / lib/rutgers.ts).
 */

import { computeBackoffMs, getCurrentSemesterId, parseSemesterId } from './webreg.js'

// =========================================================================
// 1. PURE — SOC courses.json input shapes (untrusted; everything optional)
// =========================================================================

export interface SocMeetingTime {
  /** M / T / W / TH (some feeds abbreviate Thursday as H) / F / S / U. */
  meetingDay?: string | null
  /** 24h military string, e.g. "1430". */
  startTimeMilitary?: string | null
  endTimeMilitary?: string | null
  buildingCode?: string | null
  campusName?: string | null
}

export interface SocInstructor {
  name?: string | null
}

export interface SocSection {
  index?: string | null
  openStatus?: boolean | null
  instructors?: SocInstructor[] | null
  meetingTimes?: SocMeetingTime[] | null
}

export interface SocCourse {
  courseString?: string | null
  title?: string | null
  expandedTitle?: string | null
  sections?: SocSection[] | null
}

// =========================================================================
// 1. PURE — field normalizers
// =========================================================================

/** Pinned dow mapping: M=1 T=2 W=3 TH=4 F=5 S=6 U=7 ("H" = Thursday too). */
const DOW_BY_DAY: Record<string, number> = {
  M: 1,
  T: 2,
  W: 3,
  TH: 4,
  H: 4,
  F: 5,
  S: 6,
  U: 7,
}

/** SOC meetingDay -> ISO-ish dow 1-7, or null when unmappable (online rows). */
export function dowFromMeetingDay(meetingDay: string | null | undefined): number | null {
  const key = String(meetingDay || '').trim().toUpperCase()
  return DOW_BY_DAY[key] ?? null
}

/**
 * Military "HHMM" -> minutes since midnight ("1430" -> 870, "0000" -> 0).
 * Returns null (never 0) for anything unparsable so callers can distinguish
 * midnight from a missing time.
 */
export function militaryToMinutes(time: string | null | undefined): number | null {
  const match = /^(\d{2})(\d{2})$/.exec(String(time || '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return null
  return hours * 60 + minutes
}

export type CampusSlug = 'college_ave' | 'busch' | 'livingston' | 'cook_douglass'

/**
 * SOC campusName -> one of the 4 pinned Rutgers NB campus slugs (substring,
 * case-insensitive), or null for anything else (online, downtown, blank...).
 */
export function normalizeCampus(campusName: string | null | undefined): CampusSlug | null {
  const name = String(campusName || '').toLowerCase()
  if (!name) return null
  if (name.includes('busch')) return 'busch'
  if (name.includes('livingston')) return 'livingston'
  if (name.includes('cook') || name.includes('douglass')) return 'cook_douglass'
  if (name.includes('college ave') || name.includes('cac')) return 'college_ave'
  return null
}

// =========================================================================
// 1. PURE — term-code helpers (terms.code pinned format, e.g. "fall26")
// =========================================================================

const TERM_NAMES = ['spring', 'summer', 'fall', 'winter'] as const

/** "2026-fall" (getCurrentSemesterId format) -> terms.code "fall26", or null. */
export function semesterToTermCode(semester: string): string | null {
  const parts = String(semester || '').split('-')
  if (parts.length !== 2) return null
  const year = parseInt(parts[0], 10)
  const name = parts[1].toLowerCase() as (typeof TERM_NAMES)[number]
  if (!year || !TERM_NAMES.includes(name)) return null
  return `${name}${String(year % 100).padStart(2, '0')}`
}

/**
 * Rough term bounds, used only when auto-creating a missing terms row (the
 * seeded rows — fall26 = 2026-09-01..2026-12-23 — always win).
 */
export function defaultTermBounds(
  semester: string
): { starts_on: string; ends_on: string } | null {
  const parts = String(semester || '').split('-')
  if (parts.length !== 2) return null
  const year = parseInt(parts[0], 10)
  if (!year) return null
  switch (parts[1].toLowerCase()) {
    case 'spring':
      return { starts_on: `${year}-01-20`, ends_on: `${year}-05-15` }
    case 'summer':
      return { starts_on: `${year}-05-26`, ends_on: `${year}-08-15` }
    case 'fall':
      return { starts_on: `${year}-09-01`, ends_on: `${year}-12-23` }
    case 'winter':
      return { starts_on: `${year}-12-26`, ends_on: `${year + 1}-01-18` }
    default:
      return null
  }
}

// =========================================================================
// 1. PURE — SOC JSON -> catalog rows
// =========================================================================

/** catalog_courses upsert row (onConflict school_id,term_id,code). */
export interface CatalogCourseRow {
  school_id: string
  term_id: string
  code: string
  title: string | null
}

/** catalog_section_meetings columns minus section_id (stamped by the IO). */
export interface MappedMeeting {
  dow: number
  start_min: number
  end_min: number
  building: string | null
  campus: CampusSlug | null
}

/** catalog_sections columns minus course_id, plus the section's meetings. */
export interface MappedSection {
  index_no: string
  campus: CampusSlug | null
  instructor: string | null
  is_open: boolean
  meetings: MappedMeeting[]
}

export interface MappedCatalog {
  courses: CatalogCourseRow[]
  sectionsByCourseCode: Map<string, MappedSection[]>
}

/**
 * Transform the Rutgers SOC courses.json payload into pinned catalog rows.
 *   - Courses dedup by courseString (first title wins; sections merge).
 *   - Sections dedup by index within a course; is_open <- openStatus;
 *     instructor = instructors' names joined with "; "; campus = first
 *     meeting with a recognizable campus.
 *   - Meetings keep only rows with a mappable dow AND parsable military
 *     start/end times (async-online rows have neither and carry no schedule
 *     signal). Meetings have no stable key — the IO layer delete+reinserts.
 */
export function mapCourses(
  socJson: SocCourse[],
  schoolId: string,
  termId: string
): MappedCatalog {
  const courses: CatalogCourseRow[] = []
  const sectionsByCourseCode = new Map<string, MappedSection[]>()
  const seenIndexByCode = new Map<string, Set<string>>()

  for (const course of Array.isArray(socJson) ? socJson : []) {
    const code = String(course?.courseString || '').trim()
    if (!code) continue

    if (!sectionsByCourseCode.has(code)) {
      courses.push({
        school_id: schoolId,
        term_id: termId,
        code,
        title: course.title || course.expandedTitle || null,
      })
      sectionsByCourseCode.set(code, [])
      seenIndexByCode.set(code, new Set())
    }
    const sections = sectionsByCourseCode.get(code)!
    const seenIndexes = seenIndexByCode.get(code)!

    for (const section of course.sections || []) {
      const indexNo = String(section?.index || '').trim()
      if (!indexNo || seenIndexes.has(indexNo)) continue
      seenIndexes.add(indexNo)

      const meetingTimes = section.meetingTimes || []
      const meetings: MappedMeeting[] = []
      for (const mt of meetingTimes) {
        const dow = dowFromMeetingDay(mt?.meetingDay)
        const startMin = militaryToMinutes(mt?.startTimeMilitary)
        const endMin = militaryToMinutes(mt?.endTimeMilitary)
        if (dow === null || startMin === null || endMin === null) continue
        meetings.push({
          dow,
          start_min: startMin,
          end_min: endMin,
          building: mt?.buildingCode || null,
          campus: normalizeCampus(mt?.campusName),
        })
      }

      // Section-level campus: first recognizable campus across ALL meeting
      // rows (including ones skipped above for missing day/time).
      let campus: CampusSlug | null = null
      for (const mt of meetingTimes) {
        campus = normalizeCampus(mt?.campusName)
        if (campus) break
      }

      const instructor =
        (section.instructors || [])
          .map((i) => String(i?.name || '').trim())
          .filter(Boolean)
          .join('; ') || null

      sections.push({
        index_no: indexNo,
        campus,
        instructor,
        is_open: !!section?.openStatus,
        meetings,
      })
    }
  }

  return { courses, sectionsByCourseCode }
}

// =========================================================================
// 2. IO — lazy supabase (importing this module never needs SUPABASE_* env)
// =========================================================================

type SupabaseClient = (typeof import('./supabase.js'))['supabase']
let dbPromise: Promise<SupabaseClient> | null = null
function getDb(): Promise<SupabaseClient> {
  if (!dbPromise) dbPromise = import('./supabase.js').then((m) => m.supabase)
  return dbPromise
}

// =========================================================================
// 2. IO — courses.json fetch (lib/webreg.ts pattern, bigger time budget)
// =========================================================================

const DEFAULT_BASE_URL = 'https://classes.rutgers.edu/soc/api'
// lib/webreg.ts uses 8s for the tiny openSections payload; courses.json is
// the full-term catalog (tens of MB) and gets up to 30s per attempt.
const FETCH_TIMEOUT_MS = 30_000
const FETCH_MAX_ATTEMPTS = 2
const CHUNK_SIZE = 500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchCatalogCourses(
  year: number,
  term: number,
  campus = 'NB'
): Promise<SocCourse[]> {
  const base = process.env.WEBREG_BASE_URL || DEFAULT_BASE_URL
  let lastError: unknown = null
  for (let attempt = 0; attempt < FETCH_MAX_ATTEMPTS; attempt++) {
    const url = `${base}/courses.json?year=${year}&term=${term}&campus=${campus}`
    try {
      const response = await fetch(url, {
        headers: {
          'Accept-Encoding': 'gzip, deflate',
          'User-Agent': 'ClassMate/1.0',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error(`courses.json ${response.status} for ${year}/${term}`)
      }
      const data = await response.json()
      if (!Array.isArray(data)) {
        throw new Error(`courses.json returned non-array for ${year}/${term}`)
      }
      return data as SocCourse[]
    } catch (err) {
      lastError = err
      if (attempt < FETCH_MAX_ATTEMPTS - 1) {
        await sleep(computeBackoffMs(attempt, 1_000, 8_000))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

// =========================================================================
// 2. IO — the sync
// =========================================================================

export interface SyncCatalogSummary {
  term: string
  courses: number
  sections: number
  meetings: number
  ms: number
}

/**
 * Daily full-catalog sync for one term (default: the current semester).
 *   1. Resolve the school (the seeded soc_adapter='rutgers_soc' row) and the
 *      terms row for the pinned code (e.g. "fall26"), creating the term with
 *      rough default bounds when missing.
 *   2. Fetch courses.json (year/term via parseSemesterId — TERM_CODES-
 *      corrected: fall=9, summer=7, spring=1, winter=0).
 *   3. Upsert catalog_courses in chunks of 500 (onConflict
 *      school_id,term_id,code), then catalog_sections chunks (onConflict
 *      course_id,index_no), then DELETE+reinsert catalog_section_meetings per
 *      synced section batch (meetings have no stable key).
 *
 * Closed sections omit last_seen_open_at from their upsert rows so the
 * previously recorded open timestamp is preserved rather than nulled.
 */
export async function syncCatalog(
  semester: string = getCurrentSemesterId()
): Promise<SyncCatalogSummary> {
  const t0 = Date.now()
  const parsed = parseSemesterId(semester)
  const termCode = semesterToTermCode(semester)
  if (!parsed || !termCode) throw new Error(`Invalid semester id: ${semester}`)

  const db = await getDb()

  // ---- school + term rows ------------------------------------------------
  const { data: school, error: schoolError } = await db
    .from('schools')
    .select('id')
    .eq('soc_adapter', 'rutgers_soc')
    .limit(1)
    .maybeSingle()
  if (schoolError) throw schoolError
  if (!school) {
    throw new Error('No schools row with soc_adapter=rutgers_soc (run the W1 migration seed)')
  }

  let termId: string
  const { data: existingTerm, error: termSelectError } = await db
    .from('terms')
    .select('id')
    .eq('school_id', school.id)
    .eq('code', termCode)
    .maybeSingle()
  if (termSelectError) throw termSelectError
  if (existingTerm) {
    termId = existingTerm.id
  } else {
    // Missing term: create it. upsert keyed on unique(school_id, code) keeps
    // this race-safe against a concurrent run seeding the same term.
    const bounds = defaultTermBounds(semester)
    const { data: createdTerm, error: termInsertError } = await db
      .from('terms')
      .upsert(
        {
          school_id: school.id,
          code: termCode,
          starts_on: bounds?.starts_on ?? null,
          ends_on: bounds?.ends_on ?? null,
        },
        { onConflict: 'school_id,code' }
      )
      .select('id')
      .single()
    if (termInsertError) throw termInsertError
    termId = createdTerm.id
  }

  // ---- fetch + map ---------------------------------------------------------
  const socJson = await fetchCatalogCourses(parsed.year, parsed.term)
  const { courses, sectionsByCourseCode } = mapCourses(socJson, school.id, termId)

  // ---- catalog_courses (chunks of 500) ------------------------------------
  const courseIdByCode = new Map<string, string>()
  for (let i = 0; i < courses.length; i += CHUNK_SIZE) {
    const chunk = courses.slice(i, i + CHUNK_SIZE)
    const { data, error } = await db
      .from('catalog_courses')
      .upsert(chunk, { onConflict: 'school_id,term_id,code' })
      .select('id, code')
    if (error) throw error
    for (const row of (data as { id: string; code: string }[]) || []) {
      courseIdByCode.set(row.code, row.id)
    }
  }

  // ---- catalog_sections + meetings ----------------------------------------
  const nowIso = new Date(t0).toISOString()

  interface PendingSection {
    row: Record<string, unknown>
    key: string // `${course_id}|${index_no}` — the upsert conflict key
    meetings: MappedMeeting[]
  }
  // Open and closed rows are upserted separately: closed rows carry no
  // last_seen_open_at key at all, so PostgREST leaves the stored value alone.
  const openSections: PendingSection[] = []
  const closedSections: PendingSection[] = []

  for (const [code, sections] of sectionsByCourseCode) {
    const courseId = courseIdByCode.get(code)
    if (!courseId) continue // defensive: course upsert did not return the row
    for (const s of sections) {
      const base = {
        course_id: courseId,
        index_no: s.index_no,
        campus: s.campus,
        instructor: s.instructor,
        is_open: s.is_open,
      }
      const pending: PendingSection = {
        row: s.is_open ? { ...base, last_seen_open_at: nowIso } : base,
        key: `${courseId}|${s.index_no}`,
        meetings: s.meetings,
      }
      ;(s.is_open ? openSections : closedSections).push(pending)
    }
  }

  let sectionCount = 0
  let meetingCount = 0

  const syncSectionChunk = async (chunk: PendingSection[]) => {
    const { data, error } = await db
      .from('catalog_sections')
      .upsert(
        chunk.map((p) => p.row),
        { onConflict: 'course_id,index_no' }
      )
      .select('id, course_id, index_no')
    if (error) throw error

    const idByKey = new Map<string, string>()
    for (const r of (data as { id: string; course_id: string; index_no: string }[]) || []) {
      idByKey.set(`${r.course_id}|${r.index_no}`, r.id)
    }

    const sectionIds: string[] = []
    const meetingRows: Record<string, unknown>[] = []
    for (const p of chunk) {
      const sectionId = idByKey.get(p.key)
      if (!sectionId) continue
      sectionIds.push(sectionId)
      for (const m of p.meetings) meetingRows.push({ section_id: sectionId, ...m })
    }
    sectionCount += sectionIds.length
    if (sectionIds.length === 0) return

    // Meetings have no stable key -> delete + reinsert per synced batch.
    const { error: deleteError } = await db
      .from('catalog_section_meetings')
      .delete()
      .in('section_id', sectionIds)
    if (deleteError) throw deleteError

    for (let i = 0; i < meetingRows.length; i += CHUNK_SIZE) {
      const rows = meetingRows.slice(i, i + CHUNK_SIZE)
      const { error: insertError } = await db.from('catalog_section_meetings').insert(rows)
      if (insertError) throw insertError
      meetingCount += rows.length
    }
  }

  for (const group of [openSections, closedSections]) {
    for (let i = 0; i < group.length; i += CHUNK_SIZE) {
      await syncSectionChunk(group.slice(i, i + CHUNK_SIZE))
    }
  }

  const ms = Date.now() - t0
  // Counts + timing only — the privacy hard rule bans schedule contents here.
  console.log(
    `[socCatalog] ${termCode}: ${courses.length} courses, ${sectionCount} sections, ${meetingCount} meetings, ${ms}ms`
  )

  return {
    term: termCode,
    courses: courses.length,
    sections: sectionCount,
    meetings: meetingCount,
    ms,
  }
}
