/**
 * GPA projection math — 100% CLIENT-SIDE (NEXT-STEPS P0 #2).
 *
 * POLICY: scores never leave the device. Per-assignment scores live ONLY in
 * localStorage (see loadScores/saveScores below); the server stores just the
 * course weight scheme (structure) and the user's target letter. No API call
 * in this app sends a score anywhere — do not add one.
 *
 * Module layout is deliberate: every math function below is pure and never
 * references window/localStorage, so Node tests (apps/api/tests/gpa.test.ts)
 * can import the math without a DOM. Only loadScores/saveScores touch
 * localStorage, and they check `typeof window` lazily at call time.
 */

// ---------------------------------------------------------------- types

/** One entry of a course weight scheme, e.g. { name: "Final", weight: 40 }. */
export interface WeightComponent {
  name: string
  /** Weight in percent points (0–100). Schemes may not sum to exactly 100. */
  weight: number
}

/**
 * One locally-entered score for a component. NEVER sent to the server —
 * persisted only via loadScores/saveScores (localStorage).
 */
export interface LocalScore {
  /** Matches WeightComponent.name. */
  component: string
  pointsEarned: number
  pointsPossible: number
}

export type CourseStatus = 'on_pace' | 'at_risk' | 'safe' | 'no_data'

export type Letter = 'A' | 'A-' | 'B+' | 'B' | 'B-' | 'C+' | 'C' | 'D' | 'F'

export interface GradeStep {
  letter: Letter
  /** Minimum course percent that earns this letter. */
  minPercent: number
  /** Grade points on the 4.0 scale. */
  gpa: number
}

// ---------------------------------------------------------------- scale

/**
 * Rutgers scale: A 4.0 ≥90 · B+ 3.5 ≥85 · B 3.0 ≥80 · C+ 2.5 ≥75 · C 2.0 ≥70 ·
 * D 1.0 ≥60 · F 0. A−/B− are goal-only refinements (selectable targets, shown
 * in copy like "Final ≥ 88 raises this to A−") with conventional 3.7/2.7
 * points; Rutgers' official transcript scale has no minus grades.
 * Ordered best → worst; letterForPercent takes the first step that fits.
 */
export const GRADE_SCALE: readonly GradeStep[] = [
  { letter: 'A', minPercent: 90, gpa: 4.0 },
  { letter: 'A-', minPercent: 88, gpa: 3.7 },
  { letter: 'B+', minPercent: 85, gpa: 3.5 },
  { letter: 'B', minPercent: 80, gpa: 3.0 },
  { letter: 'B-', minPercent: 78, gpa: 2.7 },
  { letter: 'C+', minPercent: 75, gpa: 2.5 },
  { letter: 'C', minPercent: 70, gpa: 2.0 },
  { letter: 'D', minPercent: 60, gpa: 1.0 },
  { letter: 'F', minPercent: 0, gpa: 0.0 },
]

/** Minimum course percent needed for a target letter (A- → 88). */
export function percentForLetter(letter: Letter): number {
  const step = GRADE_SCALE.find((s) => s.letter === letter)
  return step ? step.minPercent : 0
}

/** Letter earned at a course percent (89.99 → A-, 90 → A). */
export function letterForPercent(percent: number): Letter {
  for (const step of GRADE_SCALE) {
    if (percent >= step.minPercent) return step.letter
  }
  return 'F'
}

/** Grade points for a letter on the 4.0 scale. */
export function gpaForLetter(letter: Letter): number {
  const step = GRADE_SCALE.find((s) => s.letter === letter)
  return step ? step.gpa : 0
}

/** Grade points earned at a course percent. */
export function gpaForPercent(percent: number): number {
  return gpaForLetter(letterForPercent(percent))
}

// ---------------------------------------------------------------- math

/** Percent (0–100) scored on a single component, or null without valid data. */
function componentPercent(score: LocalScore | undefined): number | null {
  if (!score || !(score.pointsPossible > 0)) return null
  return (score.pointsEarned / score.pointsPossible) * 100
}

function scoreByComponent(scores: LocalScore[]): Map<string, LocalScore> {
  const map = new Map<string, LocalScore>()
  for (const s of scores) map.set(s.component, s)
  return map
}

/**
 * Current course percent, weight-normalized over the components that HAVE
 * data. Weights need not sum to 100 — only their ratios matter here.
 * Returns null when no component has a usable score.
 */
export function currentPercent(
  components: WeightComponent[],
  scores: LocalScore[]
): number | null {
  const byName = scoreByComponent(scores)
  let weightedSum = 0
  let gradedWeight = 0
  for (const comp of components) {
    const pct = componentPercent(byName.get(comp.name))
    if (pct === null || comp.weight <= 0) continue
    weightedSum += comp.weight * pct
    gradedWeight += comp.weight
  }
  if (gradedWeight <= 0) return null
  return weightedSum / gradedWeight
}

/**
 * Average percent needed on the not-yet-scored components to finish the
 * course at targetPercent — the "Final ≥ 88 raises this to A−" number.
 *
 * Weights are normalized against their total (schemes that sum to 80 or 105
 * still work). Exact algebra: with fraction g of the course graded at
 * average c, required on the remaining (1−g) is (target − g·c) / (1−g).
 * E.g. 60% graded at 78 overall, target 90: (90 − 46.8) / 0.4 = 108 → >100,
 * i.e. impossible.
 *
 * Returns:
 *  - the required percent (can exceed 100 = impossible, or be ≤ 0 = banked),
 *  - null when there are no components or no weight remains ungraded
 *    (the outcome is already locked in — compare currentPercent to target).
 */
export function requiredOnRemaining(
  components: WeightComponent[],
  scores: LocalScore[],
  targetPercent: number
): number | null {
  const byName = scoreByComponent(scores)
  let totalWeight = 0
  let gradedWeight = 0
  let earnedWeightedSum = 0
  for (const comp of components) {
    if (comp.weight <= 0) continue
    totalWeight += comp.weight
    const pct = componentPercent(byName.get(comp.name))
    if (pct === null) continue
    gradedWeight += comp.weight
    earnedWeightedSum += comp.weight * pct
  }
  if (totalWeight <= 0) return null

  const remainingFraction = (totalWeight - gradedWeight) / totalWeight
  if (remainingFraction <= 0) return null

  // Contribution already banked toward the final 0–100 course percent.
  const earnedContribution = earnedWeightedSum / totalWeight
  return (targetPercent - earnedContribution) / remainingFraction
}

/** Required average above this on remaining work = at_risk. */
export const AT_RISK_REQUIRED_PERCENT = 95
/** Cushion (in percent points) below current pace that counts as "safe". */
export const SAFE_MARGIN = 5

/**
 * Classify a course against a target percent:
 *  - no_data: no weight components known (deep-link to Import → Syllabus).
 *  - safe: target already banked (required ≤ 0), or the required average on
 *    remaining work sits comfortably (≥ SAFE_MARGIN points) below current
 *    pace; also all-graded courses that finished at/above target.
 *  - at_risk: required > 100 (impossible) or > AT_RISK_REQUIRED_PERCENT on
 *    the remaining weight; also all-graded courses locked below target.
 *  - on_pace: everything else — feasible, but no comfortable cushion.
 */
export function classifyCourse(
  components: WeightComponent[],
  scores: LocalScore[],
  targetPercent: number
): CourseStatus {
  if (components.length === 0 || !components.some((c) => c.weight > 0)) {
    return 'no_data'
  }

  const current = currentPercent(components, scores)
  const required = requiredOnRemaining(components, scores, targetPercent)

  if (required === null) {
    // Nothing left to grade — the outcome is locked in.
    return current !== null && current >= targetPercent ? 'safe' : 'at_risk'
  }
  if (required <= 0) return 'safe'
  if (required > AT_RISK_REQUIRED_PERCENT) return 'at_risk'
  if (current !== null && required <= current - SAFE_MARGIN) return 'safe'
  return 'on_pace'
}

// ---------------------------------------------------------------- storage
// POLICY: scores never leave the device. These helpers are the ONLY
// persistence for LocalScore data — localStorage, never the network.
// They lazily check for a browser environment so that importing this module
// (e.g. from Node tests) never touches window/localStorage.

const storageKey = (roomId: string) => `cm-grades-${roomId}`

function browserStorage(): Storage | null {
  if (typeof window === 'undefined' || !window.localStorage) return null
  return window.localStorage
}

/** Load locally-entered scores for a room. Returns [] outside the browser. */
export function loadScores(roomId: string): LocalScore[] {
  const storage = browserStorage()
  if (!storage) return []
  try {
    const raw = storage.getItem(storageKey(roomId))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (s): s is LocalScore =>
        !!s &&
        typeof s.component === 'string' &&
        typeof s.pointsEarned === 'number' &&
        typeof s.pointsPossible === 'number'
    )
  } catch {
    return []
  }
}

/** Persist locally-entered scores for a room. No-op outside the browser. */
export function saveScores(roomId: string, scores: LocalScore[]): void {
  const storage = browserStorage()
  if (!storage) return
  try {
    storage.setItem(storageKey(roomId), JSON.stringify(scores))
  } catch {
    // Quota/private-mode failures degrade silently — scores are optional.
  }
}
