import { useSystemStore } from '@/stores/system'
import ProfileStrip from '@/components/system/ProfileStrip'
import QuestList from '@/components/system/QuestList'
import MainQuestCard from '@/components/system/MainQuestCard'
import SideQuestList from '@/components/system/SideQuestList'
import LeaderboardCard from '@/components/system/LeaderboardCard'
import AchievementsCard from '@/components/system/AchievementsCard'
import EmptySystemCard from '@/components/system/EmptySystemCard'

/**
 * Dashboard pager · Page 2 "System" (README §3): ProfileStrip on top, then a
 * 1fr/380px grid — left: Daily Quests + Main Quest; right: Side Quests,
 * Weekly XP leaderboard, Achievements. Without a schedule the grids are
 * replaced by the idle-System empty card (ProfileStrip stays visible).
 */
export default function SystemView({ hasSchedule }: { hasSchedule: boolean }) {
  const daily = useSystemStore((s) => s.daily)
  const side = useSystemStore((s) => s.side)
  const main = useSystemStore((s) => s.main)
  const loaded = useSystemStore((s) => s.loaded)

  const total = daily.length
  const done = daily.filter((q) => q.done_at).length
  const allDone = total > 0 && done === total
  const earned = daily.reduce((sum, q) => sum + (q.done_at ? q.xp : 0), 0) + (allDone ? 30 : 0)

  if (!hasSchedule) {
    return (
      <div className="flex flex-col gap-[18px]">
        <ProfileStrip />
        <EmptySystemCard />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[18px]">
      <ProfileStrip />
      <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[1fr_380px]">
        <div className="flex flex-col gap-[18px]">
          {/* Daily Quests */}
          <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
            <div className="flex items-baseline justify-between px-[22px] pt-4">
              <h2 className="text-base font-bold tracking-[-0.01em] text-[#1F2937]">Daily Quests</h2>
              {total > 0 && (
                <span className="text-xs text-[#6B7280]">
                  {done}/{total} ·{' '}
                  <span className="font-mono font-semibold text-[#0F766E]">+{earned} XP</span> earned
                </span>
              )}
            </div>
            <div className="px-[22px] pb-2 pt-2.5">
              {total === 0 ? (
                <p className="pb-3.5 pt-3 text-[12.5px] text-[#6B7280]">
                  {loaded ? 'No quests yet — daily quests generate each morning at 6 AM.' : 'Loading quests…'}
                </p>
              ) : (
                <>
                  <QuestList quests={daily} variant="daily" />
                  {!allDone && (
                    <p className="pb-3.5 pt-3 text-[11.5px] text-[#6B7280]">
                      Clear all {total} →{' '}
                      <span className="font-mono font-semibold text-[#0F766E]">+30 bonus</span> and the
                      streak holds.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>

          <MainQuestCard quest={main[0] ?? null} />
        </div>

        <div className="flex flex-col gap-[18px]">
          <SideQuestList quests={side} />
          <LeaderboardCard />
          <AchievementsCard />
        </div>
      </div>
    </div>
  )
}
