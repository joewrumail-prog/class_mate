import { test } from 'node:test'
import assert from 'node:assert/strict'
import { levelFromXp, xpRequiredForLevel, QUEST_XP } from '../src/lib/xp.js'
import { levelFromXp as webLevelFromXp, xpRequiredForLevel as webXpRequiredForLevel } from '../../web/src/lib/xp.js'

test('level 1 starts at 0 XP with an 1000 XP bar', () => {
  const info = levelFromXp(0)
  assert.equal(info.level, 1)
  assert.equal(info.xpInLevel, 0)
  assert.equal(info.xpMax, 800 + 200 * 1)
  assert.equal(info.totalXp, 0)
})

test('level boundary: 999 stays level 1, 1000 rolls to level 2 with an empty bar', () => {
  assert.equal(levelFromXp(999).level, 1)
  assert.equal(levelFromXp(999).xpInLevel, 999)

  const rolled = levelFromXp(1000)
  assert.equal(rolled.level, 2)
  assert.equal(rolled.xpInLevel, 0)
  assert.equal(rolled.xpMax, 800 + 200 * 2)
})

test('cumulative thresholds: level n needs sum of xpRequiredForLevel(1..n-1)', () => {
  // 1000 (lv1) + 1200 (lv2) = 2200 total XP puts you exactly at level 3
  assert.equal(levelFromXp(2199).level, 2)
  assert.equal(levelFromXp(2200).level, 3)
  assert.equal(levelFromXp(2200).xpInLevel, 0)
})

test('negative XP clamps to zero (xp_events deletions can drive totals down)', () => {
  const info = levelFromXp(-50)
  assert.equal(info.level, 1)
  assert.equal(info.xpInLevel, 0)
  assert.equal(info.totalXp, 0)
})

test('invariants hold across a wide XP range', () => {
  for (let xp = 0; xp <= 60_000; xp += 37) {
    const info = levelFromXp(xp)
    assert.ok(info.xpInLevel >= 0, `xpInLevel >= 0 at ${xp}`)
    assert.ok(info.xpInLevel < info.xpMax, `xpInLevel < xpMax at ${xp}`)
    assert.equal(info.xpMax, xpRequiredForLevel(info.level))
    // Reconstruct: total = sum of all completed level bars + progress in current
    let sum = info.xpInLevel
    for (let l = 1; l < info.level; l++) sum += xpRequiredForLevel(l)
    assert.equal(sum, xp, `reconstructed total at ${xp}`)
  }
})

test('web mirror (apps/web/src/lib/xp.ts) computes identical levels', () => {
  for (let xp = 0; xp <= 30_000; xp += 111) {
    const api = levelFromXp(xp)
    const web = webLevelFromXp(xp)
    assert.equal(web.level, api.level, `level parity at ${xp}`)
    assert.equal(web.xpInLevel, api.xpInLevel, `xpInLevel parity at ${xp}`)
    assert.equal(web.xpMax, api.xpMax, `xpMax parity at ${xp}`)
  }
  assert.equal(webXpRequiredForLevel(12), xpRequiredForLevel(12))
})

test('XP economy matches the handoff defaults', () => {
  assert.equal(QUEST_XP.lecture, 20)
  assert.equal(QUEST_XP.review, 15)
  assert.equal(QUEST_XP.checkin, 10)
  assert.equal(QUEST_XP.gym, 20)
  assert.equal(QUEST_XP.sleep, 15)
  assert.equal(QUEST_XP.allClearBonus, 30)
  assert.equal(QUEST_XP.studySession, 25)
  assert.equal(QUEST_XP.eveningCheckin, 10)
})
