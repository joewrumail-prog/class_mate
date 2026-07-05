import { useAuthStore } from '@/stores/auth'
import { useSystemStore } from '@/stores/system'
import { xpRequiredForLevel } from '@/lib/xp'

const RING_CIRCUMFERENCE = 176 // 2 * PI * r(28), rounded — matches prototype

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.trim().slice(0, 2).toUpperCase() || 'CM'
}

function StatusBar({
  label,
  value,
  pct,
  barClass,
  caption,
}: {
  label: string
  value: string
  pct: number
  barClass: string
  caption: string
}) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px]">
        <span className="font-semibold text-[#374151]">{label}</span>
        <span className="font-mono text-[#6B7280]">{value}</span>
      </div>
      <div className="h-[5px] rounded-full bg-[#F1F5F9]">
        <div className={`h-[5px] rounded-full ${barClass}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[10px] text-[#94A3B8]">{caption}</p>
    </div>
  )
}

export default function ProfileStrip() {
  const { user } = useAuthStore()
  const { xp, streak, weeklyXp, checkin } = useSystemStore()

  const name = user?.nickname || 'Student'
  const level = xp?.level ?? 1
  const xpInLevel = xp?.xpInLevel ?? 0
  const xpMax = xp?.xpMax ?? xpRequiredForLevel(1)
  const xpPct = xpMax > 0 ? clamp((xpInLevel / xpMax) * 100, 0, 100) : 0
  const ringDash = Math.round((xpPct / 100) * RING_CIRCUMFERENCE)

  // Playful, deterministic status values derived from real streak / weekly XP.
  const energy = clamp(50 + streak * 2, 35, 95)
  const sleptHours = (6 + Math.min(streak, 14) * 0.1).toFixed(1)
  const focus = clamp(40 + Math.round(weeklyXp / 20), 30, 95)
  const deepBlocks = Math.min(5, 1 + Math.floor(weeklyXp / 250))
  const mood = streak >= 7 ? 'Great' : streak >= 3 ? 'Good' : 'OK'
  const moodPct = clamp(45 + streak * 3, 45, 92)

  return (
    <div className="flex items-center gap-[22px] rounded-2xl border border-[#E2E8F0] bg-white px-[22px] py-[18px] shadow-card">
      {/* Avatar + XP ring */}
      <div className="relative h-16 w-16 flex-none">
        <svg width="64" height="64" viewBox="0 0 64 64" className="absolute inset-0">
          <circle cx="32" cy="32" r="28" fill="none" stroke="#F1F5F9" strokeWidth="5" />
          <circle
            cx="32"
            cy="32"
            r="28"
            fill="none"
            className="stroke-brand-800"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${ringDash} ${RING_CIRCUMFERENCE}`}
            transform="rotate(-90 32 32)"
          />
        </svg>
        <div className="absolute inset-[7px] flex items-center justify-center rounded-full bg-brand-100 text-[17px] font-extrabold text-brand-900">
          {initialsOf(name)}
        </div>
        <span className="absolute -bottom-[5px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-brand-800 px-2 py-[2px] font-mono text-[9.5px] font-bold text-white">
          LV {level}
        </span>
      </div>

      {/* Name + XP bar */}
      <div className="w-[190px] flex-none">
        <p className="text-[15.5px] font-bold tracking-[-0.01em] text-[#1F2937]">{name}</p>
        <div className="mb-1 mt-[7px] flex justify-between text-[10.5px] text-[#6B7280]">
          <span className="font-semibold text-[#374151]">XP</span>
          <span className="font-mono">
            {xpInLevel}/{xpMax}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#F1F5F9]">
          <div
            className="h-1.5 rounded-full bg-gradient-to-r from-brand-600 to-brand-800 transition-[width] duration-500 ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none"
            style={{ width: `${xpPct}%` }}
          />
        </div>
      </div>

      {/* Status bars */}
      <div className="grid flex-1 grid-cols-3 gap-4 border-l border-[#F1F5F9] pl-[22px]">
        <StatusBar
          label="Energy"
          value={String(energy)}
          pct={energy}
          barClass="bg-brand-800"
          caption={`slept ${sleptHours}h`}
        />
        <StatusBar
          label="Focus"
          value={String(focus)}
          pct={focus}
          barClass="bg-brand-800"
          caption={`${deepBlocks} deep block${deepBlocks === 1 ? '' : 's'}`}
        />
        <StatusBar
          label="Mood"
          value={mood}
          pct={moodPct}
          barClass="bg-[#0D9488]"
          caption={`${Math.min(streak, 7)}-day check-in`}
        />
      </div>

      <button
        type="button"
        onClick={() => checkin('evening')}
        className="flex-none rounded-md border border-brand-200 bg-brand-50 px-3.5 py-[9px] text-[12.5px] font-bold text-brand-900 transition-colors hover:bg-brand-100"
      >
        Check in · +10 XP
      </button>
    </div>
  )
}
