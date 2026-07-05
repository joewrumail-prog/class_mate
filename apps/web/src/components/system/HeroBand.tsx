import { Link } from 'react-router-dom'
import { Flame, Upload } from 'lucide-react'
import { useAuthStore } from '@/stores/auth'
import { useSystemStore } from '@/stores/system'
import { getCurrentSemester } from '@/lib/semester'
import Crest from '@/components/system/Crest'

/**
 * Dashboard hero band (README §2): brand gradient panel with mono date kicker,
 * welcome H1, streak pill and white Import Schedule button, plus a ghost
 * crest watermark top-right. Reads auth user + store.streak itself.
 */
export default function HeroBand() {
  const { user } = useAuthStore()
  const streak = useSystemStore((s) => s.streak)

  const kicker = `${new Date()
    .toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
    .toUpperCase()} · ${getCurrentSemester().display.toUpperCase()}`
  const letter = (user?.school?.trim().charAt(0) || 'C').toUpperCase()

  return (
    <div className="relative flex flex-col gap-4 overflow-hidden rounded-2xl bg-[linear-gradient(135deg,var(--brand-800),var(--brand-900))] px-7 py-[22px] shadow-card md:flex-row md:items-center md:justify-between">
      <Crest letter={letter} size={180} variant="ghost" className="pointer-events-none absolute -right-4 -top-8" />
      <div>
        <p className="font-mono text-[11px] tracking-[0.14em] text-white/[0.72]">{kicker}</p>
        <h1 className="mt-1.5 text-[27px] font-extrabold tracking-[-0.02em] text-white">
          Welcome back, {user?.nickname}
        </h1>
        <p className="mt-1.5 text-[13px] text-white/[0.78]">
          {user?.school || 'Stay on top of your classes and meet classmates.'}
        </p>
      </div>
      <div className="relative flex items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/[0.14] px-[13px] py-1.5 text-[12.5px] font-bold text-white">
          <Flame className="h-[13px] w-[13px] text-[#FDE68A]" />
          {streak}-day streak
        </span>
        <Link
          to="/import"
          className="flex items-center gap-2 rounded-md bg-white px-4 py-[9px] text-sm font-semibold text-brand-900 hover:bg-brand-50"
        >
          <Upload className="h-[15px] w-[15px]" />
          Import Schedule
        </Link>
      </div>
    </div>
  )
}
