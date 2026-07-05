import { Check } from 'lucide-react'
import { useSystemStore } from '@/stores/system'
import type { Quest } from '@/stores/system'

interface QuestListProps {
  quests: Quest[]
  variant: 'today' | 'daily'
}

function timeLabel(dueAt: string | null): string {
  if (!dueAt) return '–'
  const d = new Date(dueAt)
  if (Number.isNaN(d.getTime())) return '–'
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function tagFor(quest: Quest): { text: string; color: string } {
  if (quest.source === 'schedule') return { text: 'CLASS', color: 'text-brand-900' }
  if (quest.meta?.slug === 'review') return { text: 'DUE', color: 'text-[#B45309]' }
  return { text: 'SYS', color: 'text-[#0F766E]' }
}

function CheckCircle({ done, size }: { done: boolean; size: 'today' | 'daily' }) {
  const dims = size === 'today' ? 'h-5 w-5' : 'h-[19px] w-[19px]'
  const icon = size === 'today' ? 'h-3 w-3' : 'h-[11px] w-[11px]'
  return (
    <span
      className={`box-border inline-flex flex-none items-center justify-center rounded-full border-[1.5px] transition-colors duration-[180ms] ${dims} ${
        done ? 'border-[#0D9488] bg-[#0D9488]' : 'border-[#CBD5E1] bg-white'
      }`}
    >
      {done && <Check className={`${icon} text-white`} strokeWidth={3} />}
    </span>
  )
}

/**
 * Shared quest rows (README §3) — one component for the Today timeline
 * and the Daily Quests card, both driven by the same store so a toggle
 * on either page stays in sync.
 */
export default function QuestList({ quests, variant }: QuestListProps) {
  const toggleQuest = useSystemStore((s) => s.toggleQuest)

  if (variant === 'today') {
    return (
      <div>
        {quests.map((q) => {
          const done = !!q.done_at
          const tag = tagFor(q)
          const isDue = tag.text === 'DUE'
          return (
            <div
              key={q.id}
              onClick={() => toggleQuest(q.id)}
              className="flex cursor-pointer select-none items-center gap-[14px] border-b border-[#F1F5F9] py-3"
            >
              <span
                className={`w-[50px] flex-none font-mono text-[13px] ${
                  isDue && !done ? 'text-[#B45309]' : 'text-[#6B7280]'
                }`}
              >
                {timeLabel(q.due_at)}
              </span>
              <CheckCircle done={done} size="today" />
              <span
                className={`flex-1 text-[14.5px] ${
                  done
                    ? 'text-[#9CA3AF] line-through'
                    : isDue
                      ? 'font-semibold text-[#1F2937]'
                      : 'text-[#374151]'
                }`}
              >
                {q.title}
              </span>
              <span className={`font-mono text-[11px] tracking-[.06em] ${done ? 'text-[#CBD5E1]' : tag.color}`}>
                {tag.text}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div>
      {quests.map((q) => {
        const done = !!q.done_at
        return (
          <div
            key={q.id}
            onClick={() => toggleQuest(q.id)}
            className="flex cursor-pointer select-none items-center gap-[13px] border-b border-[#F1F5F9] py-[9px]"
          >
            <CheckCircle done={done} size="daily" />
            <span
              className={`flex-1 text-[13.5px] ${
                done
                  ? 'text-[#9CA3AF] line-through'
                  : q.due_at
                    ? 'font-semibold text-[#1F2937]'
                    : 'text-[#374151]'
              }`}
            >
              {q.title}
              {q.due_at && (
                <span className="ml-1 font-mono text-[10px] font-normal text-[#B45309]">
                  DUE {timeLabel(q.due_at)}
                </span>
              )}
            </span>
            <span
              className={`rounded-full px-2 py-[3px] font-mono text-[10.5px] font-semibold ${
                done ? 'bg-[#F0FDFA] text-[#0F766E]' : 'bg-brand-50 text-brand-900'
              }`}
            >
              +{q.xp}
            </span>
          </div>
        )
      })}
    </div>
  )
}
