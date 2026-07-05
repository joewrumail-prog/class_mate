/**
 * XP / level math. Level is always derived from sum(xp_events.amount) —
 * never stored. Mirror of apps/web/src/lib/xp.ts; keep both in sync.
 *
 * Requirement to advance FROM level L to L+1: 800 + 200*L XP.
 * (LV12 -> 3200 XP, LV13 -> 3400 XP, matching the design mock.)
 */
export const xpRequiredForLevel = (level: number) => 800 + 200 * level

export interface LevelInfo {
  level: number
  xpInLevel: number
  xpMax: number
  totalXp: number
}

export function levelFromXp(totalXp: number): LevelInfo {
  let level = 1
  let rest = Math.max(0, totalXp)

  while (rest >= xpRequiredForLevel(level)) {
    rest -= xpRequiredForLevel(level)
    level += 1
    if (level >= 200) break // sanity cap
  }

  return { level, xpInLevel: rest, xpMax: xpRequiredForLevel(level), totalXp: Math.max(0, totalXp) }
}

/** Default XP values for generated quests (mock economy kept as defaults). */
export const QUEST_XP = {
  lecture: 20,
  review: 15,
  checkin: 10,
  assignment: 40,
  gym: 20,
  sleep: 15,
  allClearBonus: 30,
  studySession: 25,
  eveningCheckin: 10,
  // Core (main/side) quest seeds — values from the design prototype.
  mainQuest: 1000,
  sideClub: 120,
  sideInternship: 200,
  sideCert: 150,
} as const
