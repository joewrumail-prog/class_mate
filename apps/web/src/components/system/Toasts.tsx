import { Check } from 'lucide-react'
import { useSystemStore } from '@/stores/system'

/**
 * Bottom-center toast stack (README §8). Slide-up entrance via .cm-toast
 * (reduced motion handled globally); auto-dismiss after 2600ms is owned
 * by the store's pushToast.
 */
export default function Toasts() {
  const toasts = useSystemStore((s) => s.toasts)
  if (toasts.length === 0) return null

  return (
    <div className="pointer-events-none fixed bottom-[26px] left-1/2 z-[100] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className="cm-toast flex items-center gap-[9px] rounded-full bg-[#1F2937] px-[18px] py-[9px] text-[13px] font-semibold text-white shadow-[0_8px_20px_-8px_rgba(15,23,42,.5)]"
        >
          <Check className="h-3.5 w-3.5 flex-none text-[#5EEAD4]" strokeWidth={2.5} />
          {t.text}
        </div>
      ))}
    </div>
  )
}
