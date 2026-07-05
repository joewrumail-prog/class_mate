import Crest from '@/components/system/Crest'
import { useAuthStore } from '@/stores/auth'
import { useSystemStore } from '@/stores/system'

/**
 * Level-up overlay (README §8). Scale-pop entrance via .cm-pop / .cm-fade,
 * which are disabled globally under prefers-reduced-motion; the decorative
 * spinning ring opts out via motion-reduce:animate-none. Closes on button
 * or backdrop click.
 */
export default function LevelUpModal() {
  const showLevelUp = useSystemStore((s) => s.showLevelUp)
  const levelUpTo = useSystemStore((s) => s.levelUpTo)
  const closeLevelUp = useSystemStore((s) => s.closeLevelUp)
  const user = useAuthStore((s) => s.user)

  if (!showLevelUp) return null

  const letter = (user?.school?.trim().charAt(0) || 'C').toUpperCase()

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Level up"
      onClick={closeLevelUp}
      className="cm-fade fixed inset-0 z-[60] flex items-center justify-center bg-[rgba(15,23,42,.62)] backdrop-blur-[6px]"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="cm-pop relative max-w-[380px] rounded-[20px] bg-white px-[60px] pb-10 pt-11 text-center shadow-[0_24px_64px_-24px_rgba(15,23,42,.5)]"
      >
        <div className="relative mx-auto h-[120px] w-[120px]">
          <div className="absolute -inset-[26px] rounded-full bg-[radial-gradient(circle,var(--brand-100)_0%,transparent_68%)]" />
          <svg
            width="120"
            height="120"
            viewBox="0 0 120 120"
            className="absolute inset-0 animate-[cmSpin_14s_linear_infinite] motion-reduce:animate-none"
            aria-hidden="true"
          >
            <circle
              cx="60"
              cy="60"
              r="56"
              fill="none"
              className="stroke-brand-200"
              strokeWidth="2"
              strokeDasharray="6 14"
              strokeLinecap="round"
            />
          </svg>
          <Crest letter={letter} size={76} className="absolute left-[22px] top-[22px]" />
        </div>
        <p className="mt-[22px] font-mono text-[11.5px] font-bold tracking-[.22em] text-brand-900">LEVEL UP</p>
        <p className="mt-2 text-[40px] font-extrabold tracking-[-0.02em] text-[#1F2937]">
          {levelUpTo - 1} <span className="text-[#CBD5E1]">→</span>{' '}
          <span className="text-brand-900">{levelUpTo}</span>
        </p>
        <button
          type="button"
          onClick={closeLevelUp}
          className="mt-[22px] rounded-[8px] bg-brand-800 px-8 py-[11px] text-sm font-semibold text-white hover:bg-brand-hover"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
