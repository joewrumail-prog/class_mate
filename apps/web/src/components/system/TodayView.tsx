import { Link } from 'react-router-dom'
import { ArrowRight, Flame, Upload, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useSystemStore } from '@/stores/system'
import QuestList from '@/components/system/QuestList'
import SeatWatchCard from '@/components/SeatWatchCard'

const WEEKLY_GOAL = 300

/**
 * Dashboard pager · Page 1 "Today" (README §3): timeline card fed with the
 * SAME daily quest rows as the System page (one store), plus a sidebar card
 * with real weekly stats and a teal classmates row linking to /rooms.
 */
export default function TodayView({ hasSchedule }: { hasSchedule: boolean }) {
  const daily = useSystemStore((s) => s.daily)
  const weeklyXp = useSystemStore((s) => s.weeklyXp)
  const streak = useSystemStore((s) => s.streak)
  const loaded = useSystemStore((s) => s.loaded)

  const done = daily.filter((q) => q.done_at).length
  const pct = Math.min(100, Math.round((weeklyXp / WEEKLY_GOAL) * 100))

  return (
    <div className="grid grid-cols-1 items-start gap-[18px] lg:grid-cols-[1fr_340px]">
      {/* Today timeline card */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <div className="flex items-baseline justify-between px-[22px] pt-[18px]">
          <h2 className="text-lg font-bold tracking-[-0.01em] text-[#1F2937]">Today</h2>
          {hasSchedule && daily.length > 0 && (
            <span className="text-[12.5px] text-[#6B7280]">
              {done} of {daily.length} done
            </span>
          )}
        </div>
        <div className="px-[22px] pb-[18px] pt-3">
          {!hasSchedule ? (
            <div className="py-10 text-center">
              <Upload className="mx-auto mb-4 h-12 w-12 text-[#6B7280]" />
              <h3 className="mb-2 font-semibold text-[#1F2937]">No Schedule Imported Yet</h3>
              <p className="mb-4 text-sm text-[#6B7280]">
                Upload a screenshot of your schedule and your daily quests generate from it
              </p>
              <Button className="bg-brand-800 text-white hover:bg-brand-hover" asChild>
                <Link to="/import">
                  Import Schedule
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </div>
          ) : daily.length === 0 ? (
            <p className="py-3 text-[12.5px] text-[#6B7280]">
              {loaded ? 'No quests yet — daily quests generate each morning at 6 AM.' : 'Loading quests…'}
            </p>
          ) : (
            <>
              <QuestList quests={daily} variant="today" />
              <p className="mt-3 text-[11.5px] text-[#94A3B8]">
                Click a row to mark it done — quests sync with the System page.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Sidebar — weekly stats + seat watch */}
      <div className="space-y-[18px]">
      <div className="rounded-xl border border-[#E2E8F0] bg-white px-5 py-[18px] shadow-[0_1px_3px_rgba(15,23,42,0.08)]">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-[#1F2937]">This week</h3>
          <span className="font-mono text-xs text-[#6B7280]">
            {weeklyXp}/{WEEKLY_GOAL} XP
          </span>
        </div>
        <div className="mb-[7px] mt-3 h-2 rounded-full bg-[#F1F5F9]">
          <div
            className="h-2 rounded-full bg-[linear-gradient(90deg,var(--brand-600),var(--brand-800))]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <p className="text-[12.5px] text-[#6B7280]">
          Weekly XP · {pct}% of the {WEEKLY_GOAL} XP goal
        </p>
        <div className="my-4 grid grid-cols-2 gap-[14px] border-y border-[#F1F5F9] py-[14px]">
          <div>
            <p className="font-mono text-[22px] font-bold text-[#1F2937]">{weeklyXp}</p>
            <p className="mt-0.5 text-[11.5px] text-[#6B7280]">XP this week</p>
          </div>
          <div>
            <p className="flex items-center gap-[5px] text-[22px] font-bold text-[#1F2937]">
              {streak}
              <Flame className="h-4 w-4 text-[#D97706]" />
            </p>
            <p className="mt-0.5 text-[11.5px] text-[#6B7280]">day streak</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-[7px] text-[13px] font-semibold text-[#0D9488]">
            <Users className="h-[15px] w-[15px]" />
            Classmates
          </span>
          <Link to="/rooms" className="text-[12.5px] font-semibold text-brand-900">
            Open Rooms →
          </Link>
        </div>
      </div>

      <SeatWatchCard />
      </div>
    </div>
  )
}
