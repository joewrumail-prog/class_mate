/**
 * Pure-function tests for the SOC catalog mapper
 * (apps/api/src/lib/socCatalog.ts). No network, no supabase, no env: only
 * the PURE-section exports are imported, and the module keeps its supabase
 * import lazy inside the IO functions.
 *
 * Run: npx tsx --test tests/socCatalog.test.ts   (from apps/api)
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dowFromMeetingDay,
  mapCourses,
  militaryToMinutes,
  normalizeCampus,
  semesterToTermCode,
  defaultTermBounds,
  type SocCourse,
} from '../src/lib/socCatalog.js'

const SCHOOL = 'school-uuid-1'
const TERM = 'term-uuid-1'

// ---------------------------------------------------------------- fixtures

function meeting(over: Record<string, unknown> = {}): any {
  return {
    meetingDay: 'M',
    startTimeMilitary: '0900',
    endTimeMilitary: '1020',
    buildingCode: 'HLL',
    campusName: 'BUSCH',
    ...over,
  }
}

function section(over: Record<string, unknown> = {}): any {
  return {
    index: '10001',
    openStatus: true,
    instructors: [{ name: 'SMITH, JANE' }],
    meetingTimes: [meeting()],
    ...over,
  }
}

function course(over: Record<string, unknown> = {}): SocCourse {
  return {
    courseString: '01:198:111',
    title: 'INTRO COMPUTER SCI',
    sections: [section()],
    ...over,
  } as SocCourse
}

// =========================================================================
// dowFromMeetingDay
// =========================================================================

describe('dowFromMeetingDay', () => {
  test('pinned mapping M=1 T=2 W=3 TH=4 F=5 S=6 U=7', () => {
    assert.equal(dowFromMeetingDay('M'), 1)
    assert.equal(dowFromMeetingDay('T'), 2)
    assert.equal(dowFromMeetingDay('W'), 3)
    assert.equal(dowFromMeetingDay('TH'), 4)
    assert.equal(dowFromMeetingDay('F'), 5)
    assert.equal(dowFromMeetingDay('S'), 6)
    assert.equal(dowFromMeetingDay('U'), 7)
  })

  test('accepts the single-letter Thursday variant H (lib/rutgers.ts shape)', () => {
    assert.equal(dowFromMeetingDay('H'), 4)
  })

  test('case/whitespace-insensitive', () => {
    assert.equal(dowFromMeetingDay(' th '), 4)
    assert.equal(dowFromMeetingDay('m'), 1)
  })

  test('unknown, empty, and missing days map to null', () => {
    assert.equal(dowFromMeetingDay('X'), null)
    assert.equal(dowFromMeetingDay(''), null)
    assert.equal(dowFromMeetingDay(null), null)
    assert.equal(dowFromMeetingDay(undefined), null)
  })
})

// =========================================================================
// militaryToMinutes
// =========================================================================

describe('militaryToMinutes', () => {
  test('"1430" -> 870 (pinned example)', () => {
    assert.equal(militaryToMinutes('1430'), 870)
  })

  test('"0000" (midnight) -> 0, distinguishable from unparsable null', () => {
    assert.equal(militaryToMinutes('0000'), 0)
    assert.notEqual(militaryToMinutes('0000'), null)
  })

  test('boundaries: "0001" -> 1, "2359" -> 1439', () => {
    assert.equal(militaryToMinutes('0001'), 1)
    assert.equal(militaryToMinutes('2359'), 1439)
  })

  test('unparsable values -> null', () => {
    assert.equal(militaryToMinutes(''), null)
    assert.equal(militaryToMinutes(null), null)
    assert.equal(militaryToMinutes(undefined), null)
    assert.equal(militaryToMinutes('930'), null) // 3 digits
    assert.equal(militaryToMinutes('abcd'), null)
    assert.equal(militaryToMinutes('12:30'), null)
  })

  test('out-of-range hour/minute -> null', () => {
    assert.equal(militaryToMinutes('2400'), null)
    assert.equal(militaryToMinutes('1260'), null)
  })
})

// =========================================================================
// normalizeCampus
// =========================================================================

describe('normalizeCampus', () => {
  test('the 4 pinned Rutgers NB slugs (contains, case-insensitive)', () => {
    assert.equal(normalizeCampus('BUSCH'), 'busch')
    assert.equal(normalizeCampus('Busch Campus'), 'busch')
    assert.equal(normalizeCampus('LIVINGSTON'), 'livingston')
    assert.equal(normalizeCampus('Cook/Douglass'), 'cook_douglass')
    assert.equal(normalizeCampus('Douglass campus'), 'cook_douglass')
    assert.equal(normalizeCampus('COOK'), 'cook_douglass')
    assert.equal(normalizeCampus('College Avenue'), 'college_ave')
    assert.equal(normalizeCampus('College Ave'), 'college_ave')
    assert.equal(normalizeCampus('CAC'), 'college_ave')
  })

  test('unknown campuses and blanks -> null', () => {
    assert.equal(normalizeCampus('Downtown New Brunswick'), null)
    assert.equal(normalizeCampus('ONLINE'), null)
    assert.equal(normalizeCampus(''), null)
    assert.equal(normalizeCampus(null), null)
    assert.equal(normalizeCampus(undefined), null)
  })
})

// =========================================================================
// term-code helpers
// =========================================================================

describe('semesterToTermCode', () => {
  test('"2026-fall" -> "fall26" (pinned terms.code format)', () => {
    assert.equal(semesterToTermCode('2026-fall'), 'fall26')
    assert.equal(semesterToTermCode('2027-spring'), 'spring27')
    assert.equal(semesterToTermCode('2030-Winter'), 'winter30')
  })

  test('pads single-digit year suffixes', () => {
    assert.equal(semesterToTermCode('2109-fall'), 'fall09')
  })

  test('malformed ids -> null', () => {
    assert.equal(semesterToTermCode('fall26'), null)
    assert.equal(semesterToTermCode('2026-autumn'), null)
    assert.equal(semesterToTermCode(''), null)
  })
})

describe('defaultTermBounds', () => {
  test('fall matches the seeded fall26 window', () => {
    assert.deepEqual(defaultTermBounds('2026-fall'), {
      starts_on: '2026-09-01',
      ends_on: '2026-12-23',
    })
  })

  test('malformed ids -> null', () => {
    assert.equal(defaultTermBounds('nope'), null)
  })
})

// =========================================================================
// mapCourses
// =========================================================================

describe('mapCourses', () => {
  test('maps a course into pinned catalog rows', () => {
    const { courses, sectionsByCourseCode } = mapCourses([course()], SCHOOL, TERM)

    assert.deepEqual(courses, [
      { school_id: SCHOOL, term_id: TERM, code: '01:198:111', title: 'INTRO COMPUTER SCI' },
    ])

    const sections = sectionsByCourseCode.get('01:198:111')!
    assert.equal(sections.length, 1)
    assert.deepEqual(sections[0], {
      index_no: '10001',
      campus: 'busch',
      instructor: 'SMITH, JANE',
      is_open: true,
      meetings: [{ dow: 1, start_min: 540, end_min: 620, building: 'HLL', campus: 'busch' }],
    })
  })

  test('TH meetings land on dow 4', () => {
    const input = [course({ sections: [section({ meetingTimes: [meeting({ meetingDay: 'TH' })] })] })]
    const { sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)
    assert.equal(sectionsByCourseCode.get('01:198:111')![0].meetings[0].dow, 4)
  })

  test('midnight "0000" is kept as minute 0, not dropped as falsy', () => {
    const input = [
      course({
        sections: [
          section({
            meetingTimes: [meeting({ startTimeMilitary: '0000', endTimeMilitary: '0130' })],
          }),
        ],
      }),
    ]
    const { sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)
    const m = sectionsByCourseCode.get('01:198:111')![0].meetings[0]
    assert.equal(m.start_min, 0)
    assert.equal(m.end_min, 90)
  })

  test('unknown campus -> null on both the meeting and the section', () => {
    const input = [
      course({
        sections: [section({ meetingTimes: [meeting({ campusName: 'Downtown New Brunswick' })] })],
      }),
    ]
    const { sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)
    const s = sectionsByCourseCode.get('01:198:111')![0]
    assert.equal(s.campus, null)
    assert.equal(s.meetings[0].campus, null)
  })

  test('section campus comes from the first recognizable meeting campus', () => {
    const input = [
      course({
        sections: [
          section({
            meetingTimes: [
              meeting({ campusName: '** INVALID **' }),
              meeting({ meetingDay: 'W', campusName: 'LIVINGSTON' }),
            ],
          }),
        ],
      }),
    ]
    const { sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)
    assert.equal(sectionsByCourseCode.get('01:198:111')![0].campus, 'livingston')
  })

  test('meetings without a mappable day or parsable time are skipped (section survives)', () => {
    const input = [
      course({
        sections: [
          section({
            meetingTimes: [
              meeting({ meetingDay: '' }), // async-online row
              meeting({ startTimeMilitary: '', endTimeMilitary: '' }),
              meeting({ meetingDay: 'F' }), // the only keeper
            ],
          }),
        ],
      }),
    ]
    const { sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)
    const s = sectionsByCourseCode.get('01:198:111')![0]
    assert.equal(s.meetings.length, 1)
    assert.equal(s.meetings[0].dow, 5)
  })

  test('is_open mirrors openStatus; missing openStatus -> false', () => {
    const input = [
      course({
        sections: [
          section({ index: '11111', openStatus: true }),
          section({ index: '22222', openStatus: false }),
          section({ index: '33333', openStatus: undefined }),
        ],
      }),
    ]
    const { sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)
    const byIndex = new Map(sectionsByCourseCode.get('01:198:111')!.map((s) => [s.index_no, s]))
    assert.equal(byIndex.get('11111')!.is_open, true)
    assert.equal(byIndex.get('22222')!.is_open, false)
    assert.equal(byIndex.get('33333')!.is_open, false)
  })

  test('instructor is the joined instructor names; none -> null', () => {
    const input = [
      course({
        sections: [
          section({
            index: '11111',
            instructors: [{ name: 'SMITH, JANE' }, { name: 'DOE, JOHN' }],
          }),
          section({ index: '22222', instructors: [] }),
          section({ index: '33333', instructors: [{ name: '' }] }),
        ],
      }),
    ]
    const { sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)
    const byIndex = new Map(sectionsByCourseCode.get('01:198:111')!.map((s) => [s.index_no, s]))
    assert.equal(byIndex.get('11111')!.instructor, 'SMITH, JANE; DOE, JOHN')
    assert.equal(byIndex.get('22222')!.instructor, null)
    assert.equal(byIndex.get('33333')!.instructor, null)
  })

  test('dedups by courseString: first title wins, sections merge, dup indexes drop', () => {
    const input = [
      course({ title: 'FIRST TITLE', sections: [section({ index: '10001' })] }),
      course({
        title: 'SECOND TITLE',
        sections: [
          section({ index: '10002' }),
          section({ index: '10001' }), // duplicate index across entries
        ],
      }),
    ]
    const { courses, sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)

    assert.equal(courses.length, 1)
    assert.equal(courses[0].title, 'FIRST TITLE')

    const indexes = sectionsByCourseCode.get('01:198:111')!.map((s) => s.index_no)
    assert.deepEqual(indexes.sort(), ['10001', '10002'])
  })

  test('skips courses without a courseString and sections without an index', () => {
    const input = [
      course({ courseString: '' }),
      course({ courseString: null }),
      course({ sections: [section({ index: '' }), section({ index: '55555' })] }),
    ]
    const { courses, sectionsByCourseCode } = mapCourses(input, SCHOOL, TERM)

    assert.equal(courses.length, 1)
    assert.equal(courses[0].code, '01:198:111')
    const sections = sectionsByCourseCode.get('01:198:111')!
    assert.equal(sections.length, 1)
    assert.equal(sections[0].index_no, '55555')
  })

  test('empty input -> empty rows', () => {
    const { courses, sectionsByCourseCode } = mapCourses([], SCHOOL, TERM)
    assert.deepEqual(courses, [])
    assert.equal(sectionsByCourseCode.size, 0)
  })

  test('non-array input is tolerated as empty (untrusted feed)', () => {
    const { courses, sectionsByCourseCode } = mapCourses(null as any, SCHOOL, TERM)
    assert.deepEqual(courses, [])
    assert.equal(sectionsByCourseCode.size, 0)
  })
})
