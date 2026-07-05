import { Link } from 'react-router-dom'
import { Upload } from 'lucide-react'
import Crest from '@/components/system/Crest'
import { useAuthStore } from '@/stores/auth'

export default function EmptySystemCard() {
  const { user } = useAuthStore()
  const letter = (user?.school?.trim().charAt(0) || 'C').toUpperCase()

  return (
    <div className="flex justify-center">
      <div className="w-full max-w-[420px] rounded-2xl border border-dashed border-[#CBD5E1] bg-white px-10 py-12 text-center">
        <Crest letter={letter} size={64} variant="dashed" className="mx-auto opacity-35" />
        <h2 className="mb-1.5 mt-[18px] text-[19px] font-bold tracking-[-0.01em] text-[#1F2937]">
          Your System is idle
        </h2>
        <p className="mb-[22px] text-[13.5px] leading-relaxed text-[#6B7280]">
          Import your schedule and ClassMate generates your daily quests, joins your course rooms,
          and starts tracking progress — automatically.
        </p>
        <Link
          to="/import"
          className="inline-flex items-center gap-2 rounded-md bg-brand-800 px-[18px] py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover"
        >
          <Upload size={15} />
          Import Schedule
        </Link>
      </div>
    </div>
  )
}
