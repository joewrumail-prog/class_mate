/**
 * XP / level math — mirror of apps/api/src/lib/xp.ts; keep both in sync.
 * Level is always derived from total XP (sum of xp_events), never stored.
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
    if (level >= 200) break
  }

  return { level, xpInLevel: rest, xpMax: xpRequiredForLevel(level), totalXp: Math.max(0, totalXp) }
}
