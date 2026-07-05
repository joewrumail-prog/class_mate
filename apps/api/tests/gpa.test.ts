import { test } from 'node:test'
import assert from 'node:assert/strict'
// POLICY GUARD: import ONLY the pure math half of gpa.ts. loadScores/saveScores
// (the localStorage helpers) are deliberately NOT imported — importing the math
// must never touch window/localStorage, and this suite proves it runs in bare
// Node. Scores never leave the device; the server never sees them.
import {
  GRADE_SCALE,
  percentForLetter,
  letterForPercent,
  gpaForLetter,
  gpaForPercent,
  currentPercent,
  requiredOnRemaining,
  classifyCourse,
  AT_RISK_REQUIRED_PERCENT,
  SAFE_MARGIN,
} from '../../web/src/lib/gpa.js'
import type { WeightComponent, LocalScore } from '../../web/src/lib/gpa.js'

function assertClose(actual: number | null, expected: number, eps = 1e-9) {
  assert.ok(actual !== null, `expected ${expected}, got null`)
  assert.ok(
    Math.abs((actual as number) - expected) < eps,
    `expected ${expected}, got ${actual}`
  )
}

test('module imports without a DOM — math half never touches window', () => {
  // If gpa.ts referenced window/localStorage at module scope (or from any math
  // function), the import at the top of this file would already have thrown.
  assert.equal(typeof (globalThis as Record<string, unknown>).window, 'undefined')
})

// ---------------------------------------------------------------- currentPercent

test('weighted current % over components with data only (partial data)', () => {
  const components: WeightComponent[] = [
    { name: 'Homework', weight: 30 },
    { name: 'Midterm', weight: 30 },
    { name: 'Final', weight: 40 },
  ]
  const scores: LocalScore[] = [
    { component: 'Homework', pointsEarned: 45, pointsPossible: 50 }, // 90%
    { component: 'Midterm', pointsEarned: 63, pointsPossible: 90 }, // 70%
  ]
  // Final has no data → normalize over the 60 graded weight points:
  // (30·90 + 30·70) / 60 = 80
  assertClose(currentPercent(components, scores), 80)
})

test('normalization when weights do not sum to 100', () => {
  const components: WeightComponent[] = [
    { name: 'Homework', weight: 30 },
    { name: 'Final', weight: 50 },
  ] // sums to 80
  const scores: LocalScore[] = [
    { component: 'Homework', pointsEarned: 45, pointsPossible: 50 }, // 90%
  ]
  // Only ratios matter for current %: 90 on all graded work.
  assertClose(currentPercent(components, scores), 90)
})

test('currentPercent ignores unknown components, zero pointsPossible, zero weights', () => {
  const components: WeightComponent[] = [
    { name: 'Homework', weight: 40 },
    { name: 'Attendance', weight: 0 },
  ]
  assert.equal(
    currentPercent(components, [
      { component: 'Quizzes', pointsEarned: 10, pointsPossible: 10 }, // not in scheme
      { component: 'Homework', pointsEarned: 5, pointsPossible: 0 }, // unusable
      { component: 'Attendance', pointsEarned: 1, pointsPossible: 1 }, // zero weight
    ]),
    null
  )
  assert.equal(currentPercent(components, []), null)
  assert.equal(currentPercent([], []), null)
})

// ---------------------------------------------------------- requiredOnRemaining

test('requiredOnRemaining exact algebra — impossible case from the spec', () => {
  // 60% of the course graded at 78 overall, 40% weight remaining, target 90:
  // (90 − 0.6·78) / 0.4 = (90 − 46.8) / 0.4 = 108 → impossible (> 100).
  const components: WeightComponent[] = [
    { name: 'Midterm', weight: 60 },
    { name: 'Final', weight: 40 },
  ]
  const scores: LocalScore[] = [
    { component: 'Midterm', pointsEarned: 78, pointsPossible: 100 },
  ]
  assertClose(requiredOnRemaining(components, scores, 90), 108)
  assert.equal(classifyCourse(components, scores, 90), 'at_risk')
})

test('requiredOnRemaining exact algebra — feasible case', () => {
  const components: WeightComponent[] = [
    { name: 'Midterm', weight: 60 },
    { name: 'Final', weight: 40 },
  ]
  const scores: LocalScore[] = [
    { component: 'Midterm', pointsEarned: 78, pointsPossible: 100 },
  ]
  // (80 − 46.8) / 0.4 = 83 → doable, but above current pace − margin → on_pace
  assertClose(requiredOnRemaining(components, scores, 80), 83)
  assert.equal(classifyCourse(components, scores, 80), 'on_pace')
})

test('requiredOnRemaining normalizes weights that do not sum to 100', () => {
  const components: WeightComponent[] = [
    { name: 'Homework', weight: 30 },
    { name: 'Final', weight: 50 },
  ] // total 80: graded fraction 30/80, remaining 50/80
  const scores: LocalScore[] = [
    { component: 'Homework', pointsEarned: 45, pointsPossible: 50 }, // 90%
  ]
  // banked = 30·90/80 = 33.75 → (80 − 33.75) / 0.625 = 74
  assertClose(requiredOnRemaining(components, scores, 80), 74)
})

test('requiredOnRemaining with no scores equals the target itself', () => {
  const components: WeightComponent[] = [
    { name: 'Homework', weight: 50 },
    { name: 'Final', weight: 50 },
  ]
  assertClose(requiredOnRemaining(components, [], 85), 85)
})

test('requiredOnRemaining returns null when nothing remains or no components', () => {
  const components: WeightComponent[] = [{ name: 'Project', weight: 100 }]
  const scores: LocalScore[] = [
    { component: 'Project', pointsEarned: 92, pointsPossible: 100 },
  ]
  assert.equal(requiredOnRemaining(components, scores, 90), null)
  assert.equal(requiredOnRemaining([], [], 90), null)
})

// -------------------------------------------------------------------- letters

test('letter boundaries: 89.99 vs 90 (and the rest of the scale)', () => {
  assert.equal(letterForPercent(90), 'A')
  assert.equal(letterForPercent(89.99), 'A-') // goal-only refinement ≥ 88
  assert.equal(letterForPercent(87.99), 'B+')
  assert.equal(letterForPercent(85), 'B+')
  assert.equal(letterForPercent(84.99), 'B')
  assert.equal(letterForPercent(80), 'B')
  assert.equal(letterForPercent(79.99), 'B-')
  assert.equal(letterForPercent(75), 'C+')
  assert.equal(letterForPercent(74.99), 'C')
  assert.equal(letterForPercent(70), 'C')
  assert.equal(letterForPercent(69.99), 'D')
  assert.equal(letterForPercent(60), 'D')
  assert.equal(letterForPercent(59.99), 'F')
  assert.equal(letterForPercent(0), 'F')
  assert.equal(letterForPercent(-5), 'F')
  assert.equal(letterForPercent(150), 'A')
})

test('letter ⇄ percent ⇄ gpa mapping matches the Rutgers scale', () => {
  assert.equal(percentForLetter('A'), 90)
  assert.equal(percentForLetter('A-'), 88)
  assert.equal(percentForLetter('B+'), 85)
  assert.equal(percentForLetter('B'), 80)
  assert.equal(percentForLetter('B-'), 78)
  assert.equal(percentForLetter('C+'), 75)
  assert.equal(percentForLetter('C'), 70)
  assert.equal(percentForLetter('D'), 60)
  assert.equal(percentForLetter('F'), 0)

  assert.equal(gpaForLetter('A'), 4.0)
  assert.equal(gpaForLetter('B+'), 3.5)
  assert.equal(gpaForLetter('B'), 3.0)
  assert.equal(gpaForLetter('C+'), 2.5)
  assert.equal(gpaForLetter('C'), 2.0)
  assert.equal(gpaForLetter('D'), 1.0)
  assert.equal(gpaForLetter('F'), 0)

  assert.equal(gpaForPercent(90), 4.0)
  assert.equal(gpaForPercent(89.99), 3.7) // A- goal step
  assert.equal(gpaForPercent(85), 3.5)
  assert.equal(gpaForPercent(59.99), 0)

  // Scale is ordered best → worst so letterForPercent's first match wins.
  for (let i = 1; i < GRADE_SCALE.length; i++) {
    assert.ok(GRADE_SCALE[i].minPercent < GRADE_SCALE[i - 1].minPercent)
    assert.ok(GRADE_SCALE[i].gpa <= GRADE_SCALE[i - 1].gpa)
  }
})

// -------------------------------------------------------------- classification

test('no_data: no components, or only zero-weight components', () => {
  assert.equal(classifyCourse([], [], 90), 'no_data')
  assert.equal(
    classifyCourse([{ name: 'Attendance', weight: 0 }], [], 90),
    'no_data'
  )
})

test('at_risk: required > 100 is impossible; > threshold is also at risk', () => {
  const components: WeightComponent[] = [
    { name: 'Midterm', weight: 50 },
    { name: 'Final', weight: 50 },
  ]
  const scores: LocalScore[] = [
    { component: 'Midterm', pointsEarned: 70, pointsPossible: 100 },
  ]
  // (85 − 35) / 0.5 = 100 → feasible on paper but > 95 on remaining → at_risk
  assertClose(requiredOnRemaining(components, scores, 85), 100)
  assert.ok(100 > AT_RISK_REQUIRED_PERCENT)
  assert.equal(classifyCourse(components, scores, 85), 'at_risk')
})

test('safe: target already banked (required ≤ 0)', () => {
  const components: WeightComponent[] = [
    { name: 'Midterm', weight: 60 },
    { name: 'Final', weight: 40 },
  ]
  const scores: LocalScore[] = [
    { component: 'Midterm', pointsEarned: 95, pointsPossible: 100 },
  ]
  // banked 57 ≥ target 50 → required (50 − 57) / 0.4 = −17.5 → safe even at 0s
  assertClose(requiredOnRemaining(components, scores, 50), -17.5)
  assert.equal(classifyCourse(components, scores, 50), 'safe')
})

test('safe: required sits comfortably below current pace', () => {
  const components: WeightComponent[] = [
    { name: 'Midterm', weight: 60 },
    { name: 'Final', weight: 40 },
  ]
  const scores: LocalScore[] = [
    { component: 'Midterm', pointsEarned: 78, pointsPossible: 100 },
  ]
  // target 70 → required (70 − 46.8) / 0.4 = 58 ≤ current 78 − SAFE_MARGIN
  assertClose(requiredOnRemaining(components, scores, 70), 58)
  assert.ok(58 <= 78 - SAFE_MARGIN)
  assert.equal(classifyCourse(components, scores, 70), 'safe')
})

test('fully graded course: outcome locked in', () => {
  const components: WeightComponent[] = [{ name: 'Project', weight: 100 }]
  const scores: LocalScore[] = [
    { component: 'Project', pointsEarned: 92, pointsPossible: 100 },
  ]
  assert.equal(classifyCourse(components, scores, 90), 'safe')
  assert.equal(classifyCourse(components, scores, 95), 'at_risk')
})

test('weights known but no scores yet: feasible target reads on_pace', () => {
  const components: WeightComponent[] = [
    { name: 'Homework', weight: 50 },
    { name: 'Final', weight: 50 },
  ]
  // required = 90 on everything — steep but ≤ 95 → on_pace, not at_risk
  assert.equal(classifyCourse(components, [], 90), 'on_pace')
  // an impossible ask with no data is still at_risk
  assert.equal(classifyCourse(components, [], 96), 'at_risk')
})
