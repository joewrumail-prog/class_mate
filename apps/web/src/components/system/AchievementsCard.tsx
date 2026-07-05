import { CalendarCheck, Flame, Medal, Target, Trophy, type LucideIcon } from 'lucide-react'
import { useSystemStore } from '@/stores/system'

interface BadgeDef {
  id: string
  title: string
  hint: string
  icon: LucideIcon
  tone: 'brand' | 'teal'
  earned: boolean
}

export default function AchievementsCard() {
  const { xp, weeklyXp, streak } = useSystemStore()
  const level = xp?.level ?? 0
  const totalXp = xp?.totalXp ?? 0

  const badges: BadgeDef[] = [
    { id: 'streak-3', title: 'Kindled', hint: 'hold a 3-day streak', icon: Flame, tone: 'brand', earned: streak >= 3 },
    { id: 'streak-7', title: 'Week Streak', hint: 'hold a 7-day streak', icon: CalendarCheck, tone: 'brand', earned: streak >= 7 },
    { id: 'level-5', title: 'Level 5', hint: 'reach level 5', icon: Trophy, tone: 'brand', earned: level >= 5 },
    { id: 'weekly-100', title: 'Weekly 100', hint: 'earn 100 XP this week', icon: Target, tone: 'teal', earned: weeklyXp >= 100 },
    { id: 'xp-1000', title: 'XP Grinder', hint: 'earn 1,000 XP total', icon: Medal, tone: 'brand', earned: totalXp >= 1000 },
  ]

  const next = badges.find((b) => !b.earned)

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white px-[18px] py-4 shadow-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-[13.5px] font-bold text-[#1F2937]">Achievements</h3>
        <span className="text-[11.5px] font-semibold text-brand-900">All →</span>
      </div>
      <div className="mt-3 flex gap-2.5">
        {badges.map((badge) => {
          const Icon = badge.icon
          if (!badge.earned) {
            return (
              <div
                key={badge.id}
                title={`${badge.title} — ${badge.hint}`}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-dashed border-[#CBD5E1] bg-[#F8FAFC]"
              >
                <Icon size={17} className="text-[#CBD5E1]" />
              </div>
            )
          }
          return (
            <div
              key={badge.id}
              title={badge.title}
              className={
                badge.tone === 'teal'
                  ? 'flex h-11 w-11 items-center justify-center rounded-full border border-[#CCFBF1] bg-[#F0FDFA]'
                  : 'flex h-11 w-11 items-center justify-center rounded-full border border-brand-200 bg-brand-50'
              }
            >
              <Icon size={19} className={badge.tone === 'teal' ? 'text-[#0D9488]' : 'text-brand-800'} />
            </div>
          )
        })}
      </div>
      <p className="mt-2.5 text-[11.5px] text-[#6B7280]">
        {next ? (
          <>
            Next: <strong className="font-semibold text-[#374151]">{next.title}</strong> — {next.hint}
          </>
        ) : (
          'All badges earned — keep the streak alive.'
        )}
      </p>
    </div>
  )
}
