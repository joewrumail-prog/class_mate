import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webregDeepLink, buildSeatAlertEmail } from '../src/lib/alerts.js'
import { parseSemesterId } from '../src/lib/webreg.js'
import { TERM_CODES } from '../src/lib/rutgers.js'

test('Rutgers term codes: fall=9, summer=7 (verified against live SOC API 2026-07)', () => {
  // Regression guard — these were swapped in the repo since day one, which
  // made fall polling/search silently query the summer term.
  assert.equal(TERM_CODES.FALL, 9)
  assert.equal(TERM_CODES.SUMMER, 7)
  assert.equal(TERM_CODES.SPRING, 1)
  assert.equal(TERM_CODES.WINTER, 0)

  assert.deepEqual(parseSemesterId('2026-fall'), { year: 2026, term: 9 })
  assert.deepEqual(parseSemesterId('2026-summer'), { year: 2026, term: 7 })
  assert.deepEqual(parseSemesterId('2027-spring'), { year: 2027, term: 1 })
  assert.equal(parseSemesterId('garbage'), null)
})

test('webregDeepLink builds the sniper-style registration URL', () => {
  assert.equal(
    webregDeepLink('2026-fall', '10634'),
    'https://sims.rutgers.edu/webreg/editSchedule.htm?login=cas&semesterSelection=92026&indexList=10634'
  )
  assert.equal(
    webregDeepLink('2027-spring', '01234'),
    'https://sims.rutgers.edu/webreg/editSchedule.htm?login=cas&semesterSelection=12027&indexList=01234'
  )
})

test('webregDeepLink rejects malformed input', () => {
  assert.equal(webregDeepLink('not-a-semester', '10634'), null)
  assert.equal(webregDeepLink('2026-fall', 'DROP TABLE'), null)
  assert.equal(webregDeepLink('2026-fall', '1234567'), null) // > 6 digits
  assert.equal(webregDeepLink('2026-fall', ''), null)
})

test('seat alert email carries the index, course, and deep link', () => {
  const email = buildSeatAlertEmail({
    sectionIndex: '10634',
    courseCode: '01:198:111',
    semester: '2026-fall',
  })
  assert.match(email.subject, /01:198:111/)
  assert.match(email.subject, /10634/)
  assert.match(email.text, /semesterSelection=92026&indexList=10634/)
  assert.match(email.html, /semesterSelection=92026&indexList=10634/)
  assert.match(email.html, /10634/)
})

test('seat alert email degrades gracefully without a course code', () => {
  const email = buildSeatAlertEmail({
    sectionIndex: '55555',
    courseCode: null,
    semester: '2026-fall',
  })
  assert.match(email.subject, /55555/)
  assert.match(email.text, /your watched section/)
})
