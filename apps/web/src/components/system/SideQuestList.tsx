import {
  Award,
  BookOpen,
  Briefcase,
  Dumbbell,
  Moon,
  Target,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { Quest } from '@/stores/system'

const SLUG_ICONS: Record<string, LucideIcon> = {
  club: Users,
  internship: Briefcase,
  career: Briefcase,
  cert: Award,
  certification: Award,
  gym: Dumbbell,
  fitness: Dumbbell,
  sleep: Moon,
  review: BookOpen,
  reading: BookOpen,
}

function subtitleOf(quest: Quest): string | null {
  const meta = quest.meta || {}
  if (typeof meta.subtitle === 'string' && meta.subtitle) return meta.subtitle
  const progress = meta.progress
  if (progress && typeof progress.current === 'number' && typeof progress.target === 'number') {
    return `${progress.current}/${progress.target}`
  }
  return null
}

export default function SideQuestList({ quests }: { quests: Quest[] }) {
  if (quests.length === 0) return null

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white px-[22px] pb-2 pt-4 shadow-sm">
      <h2 className="mb-1 text-base font-bold tracking-[-0.01em] text-[#1F2937]">Side Quests</h2>
      {quests.map((quest, i) => {
        const slug = typeof quest.meta?.slug === 'string' ? quest.meta.slug : ''
        const Icon = SLUG_ICONS[slug] ?? Target
        const subtitle = subtitleOf(quest)
        return (
          <div
            key={quest.id}
            className={`flex items-center gap-3.5 py-3 ${i < quests.length - 1 ? 'border-b border-[#F1F5F9]' : ''}`}
          >
            <div className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lg bg-brand-50">
              <Icon size={15} className="text-brand-800" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13.5px] font-semibold text-[#1F2937]">{quest.title}</p>
              {subtitle && <p className="mt-[3px] text-[11.5px] text-[#6B7280]">{subtitle}</p>}
            </div>
            <span className="flex-none font-mono text-[10.5px] font-semibold text-brand-900">+{quest.xp}</span>
          </div>
        )
      })}
    </div>
  )
}
