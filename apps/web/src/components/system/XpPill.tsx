import { useSystemStore } from '@/stores/system'

/**
 * Header XP pill (README §1). Pure render from the system store —
 * does NOT fetch. Renders nothing until the summary has loaded.
 */
export default function XpPill() {
  const xp = useSystemStore((s) => s.xp)
  if (!xp) return null

  const pct = Math.max(2, Math.round((xp.xpInLevel / xp.xpMax) * 100))

  return (
    <div className="flex items-center gap-[7px] rounded-full border border-brand-200 bg-brand-50 py-1 pl-2 pr-3">
      <span className="rounded-full bg-brand-800 px-[7px] py-[2px] font-mono text-[11px] font-bold text-white">
        LV {xp.level}
      </span>
      <div className="h-[5px] w-[72px] overflow-hidden rounded-full bg-brand-100">
        <div
          className="h-[5px] rounded-full bg-brand-800 transition-[width] duration-500 ease-[cubic-bezier(.16,1,.3,1)]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-[10.5px] text-[#6B7280]">
        {xp.xpInLevel}/{xp.xpMax}
      </span>
    </div>
  )
}
