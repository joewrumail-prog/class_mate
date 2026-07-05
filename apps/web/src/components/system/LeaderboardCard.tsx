import { useEffect, useState } from 'react'
import { authFetch } from '@/lib/api'

interface LeaderboardRow {
  id: string
  name: string
  xp: number
  isMe: boolean
  rank: number
}

export default function LeaderboardCard() {
  const [rows, setRows] = useState<LeaderboardRow[]>([])

  useEffect(() => {
    let cancelled = false
    const fetchRows = async () => {
      try {
        const res = await authFetch('/api/system/leaderboard')
        const data = await res.json()
        if (!cancelled && data.success) {
          setRows(data.rows || [])
        }
      } catch (err) {
        console.error('Leaderboard fetch failed:', err)
      }
    }
    fetchRows()
    return () => {
      cancelled = true
    }
  }, [])

  if (rows.length < 2) return null

  return (
    <div className="rounded-xl border border-[#E2E8F0] bg-white shadow-sm">
      <div className="flex items-center justify-between px-[18px] pt-3.5">
        <h3 className="text-[13.5px] font-bold text-[#1F2937]">Weekly XP</h3>
        <span className="text-[11px] text-[#6B7280]">friends this week</span>
      </div>
      <div className="px-[18px] pb-3 pt-2">
        {rows.map((row) =>
          row.isMe ? (
            <div
              key={row.id}
              className="-mx-2 my-[2px] flex items-center gap-2.5 rounded-[7px] border border-brand-200 bg-brand-50 px-2 py-1.5 text-[13px]"
            >
              <span className="w-3 flex-none font-mono text-[11px] font-bold text-brand-900">{row.rank}</span>
              <span className="flex-1 truncate font-bold text-[#1F2937]">You</span>
              <span className="flex-none font-mono text-xs font-bold text-brand-900">{row.xp}</span>
            </div>
          ) : (
            <div key={row.id} className="flex items-center gap-2.5 py-1.5 text-[13px]">
              <span className="w-3 flex-none font-mono text-[11px] text-[#6B7280]">{row.rank}</span>
              <span className="flex-1 truncate text-[#374151]">{row.name}</span>
              <span className="flex-none font-mono text-xs text-[#6B7280]">{row.xp}</span>
            </div>
          )
        )}
      </div>
    </div>
  )
}
