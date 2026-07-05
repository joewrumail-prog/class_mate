import { Check, GraduationCap, Lock } from 'lucide-react'
import type { Quest } from '@/stores/system'

interface Milestone {
  label: string
  state: 'done' | 'active' | 'locked'
  detail?: string
}

interface MainQuestProgress {
  current: number
  target: number
  unit?: string
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

export default function MainQuestCard({ quest }: { quest: Quest | null }) {
  if (!quest) return null

  const milestones: Milestone[] = Array.isArray(quest.meta?.milestones) ? quest.meta.milestones : []
  const progress: MainQuestProgress | undefined =
    quest.meta?.progress && typeof quest.meta.progress.current === 'number' && typeof quest.meta.progress.target === 'number'
      ? quest.meta.progress
      : undefined
  const pace: string | null = typeof quest.meta?.pace === 'string' ? quest.meta.pace : null

  const doneCount = milestones.filter((m) => m.state === 'done').length
  const pct =
    progress && progress.target > 0
      ? clamp(Math.round((progress.current / progress.target) * 100), 0, 100)
      : milestones.length > 0
        ? Math.round((doneCount / milestones.length) * 100)
        : 0
  const progressLabel = progress
    ? `${progress.current}/${progress.target} ${progress.unit ?? 'credits'}`
    : milestones.length > 0
      ? `${doneCount}/${milestones.length} milestones`
      : null

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-[radial-gradient(circle_at_top,var(--brand-50)_0%,#FFFFFF_60%)] px-5 py-4 shadow-sm">
      <div className="flex items-center gap-2">
        <GraduationCap size={16} className="flex-none text-brand-800" />
        <h3 className="text-[14.5px] font-bold tracking-[-0.01em] text-[#1F2937]">{quest.title}</h3>
      </div>

      <div className="mt-3 h-2 rounded-full bg-[#F1F5F9]">
        <div
          className="h-2 rounded-full bg-gradient-to-r from-brand-600 to-brand-800"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-[5px] flex justify-between text-[11px] text-[#6B7280]">
        <span className="font-mono">{progressLabel}</span>
        {pace && <span className="font-semibold text-[#16A34A]">{pace}</span>}
      </div>

      {milestones.length > 0 && (
        <div className="mt-3 flex flex-col">
          {milestones.map((m, i) => (
            <div key={`${m.label}-${i}`} className="flex items-center gap-[9px] py-1.5 text-[12.5px]">
              {m.state === 'done' ? (
                <Check size={13} strokeWidth={3} className="flex-none text-[#0F766E]" />
              ) : m.state === 'active' ? (
                <span className="box-border h-[13px] w-[13px] flex-none rounded-full border-2 border-brand-800" />
              ) : (
                <Lock size={13} strokeWidth={2.5} className="flex-none text-[#94A3B8]" />
              )}
              <span
                className={
                  m.state === 'active'
                    ? 'flex-1 font-semibold text-[#1F2937]'
                    : m.state === 'locked'
                      ? 'flex-1 text-[#94A3B8]'
                      : 'flex-1 text-[#6B7280]'
                }
              >
                {m.label}
              </span>
              <span
                className={
                  m.state === 'done'
                    ? 'font-mono text-[10.5px] text-[#0F766E]'
                    : m.state === 'active'
                      ? 'font-mono text-[10.5px] text-brand-900'
                      : 'font-mono text-[10.5px] text-[#94A3B8]'
                }
              >
                {m.state === 'done' ? 'DONE' : m.state === 'locked' ? 'LOCKED' : m.detail ?? ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
