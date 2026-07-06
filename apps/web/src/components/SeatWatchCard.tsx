import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { authFetch } from '@/lib/api'
import { Bell, ExternalLink, Loader2, Plus, X } from 'lucide-react'

/**
 * Basic Seat Watch (Rutgers Course Sniper model): enter a section index from
 * WebReg/SOC, we poll open sections and email you the moment a seat opens,
 * with a one-click WebReg deep link. Functional baseline UI — the designed
 * version replaces this skin later; the API contract stays.
 */

interface Watch {
  id: string
  section_index: string
  course_code: string | null
  semester: string
  status: 'open' | 'closed' | 'unknown'
  active: boolean
  last_checked_at: string | null
  registerUrl: string | null
}

interface SlotInfo {
  used: number
  limit: number | null
  unlimited: boolean
}

const STATUS_DOT: Record<Watch['status'], string> = {
  open: 'bg-green-500',
  closed: 'bg-red-400',
  unknown: 'bg-slate-300',
}

const STATUS_LABEL: Record<Watch['status'], string> = {
  open: 'Open now',
  closed: 'Closed',
  unknown: 'Checking…',
}

export default function SeatWatchCard() {
  const [watches, setWatches] = useState<Watch[]>([])
  const [slots, setSlots] = useState<SlotInfo | null>(null)
  const [degraded, setDegraded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [index, setIndex] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const res = await authFetch('/api/seatwatch')
      const data = await res.json()
      if (data.success) {
        setWatches((data.watches || []).filter((w: Watch) => w.active))
        setSlots(data.slots || null)
        setDegraded(!!data.health?.degradedIcsOnly)
      }
    } catch (err) {
      console.error('Seat watch fetch failed:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const addWatch = async () => {
    const clean = index.trim()
    if (!/^\d{1,6}$/.test(clean)) {
      setError('Enter a section index (digits only, e.g. 10634)')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await authFetch('/api/seatwatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sectionIndex: clean }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(
          data.code === 'SLOT_LIMIT'
            ? 'Free plan tracks 2 sections. Refer 3 friends to unlock unlimited.'
            : data.error || 'Could not add watch'
        )
        return
      }
      setIndex('')
      await refresh()
    } catch {
      setError('Could not add watch')
    } finally {
      setBusy(false)
    }
  }

  const removeWatch = async (id: string) => {
    setWatches((prev) => prev.filter((w) => w.id !== id))
    try {
      await authFetch(`/api/seatwatch/${id}`, { method: 'DELETE' })
    } finally {
      refresh()
    }
  }

  const slotsLabel = slots
    ? slots.unlimited
      ? `${slots.used} tracked · Unlimited`
      : `${slots.used}/${slots.limit} slots`
    : ''

  return (
    <Card className="border-[#E2E8F0] shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg text-[#1F2937]">
            <Bell className="h-5 w-5 text-[#1E40AF]" />
            Seat Watch
          </CardTitle>
          {slotsLabel && (
            <span className="font-mono text-xs text-[#6B7280]">{slotsLabel}</span>
          )}
        </div>
        <CardDescription className="text-[#6B7280]">
          Track a WebReg section index — we email you the moment a seat opens.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {degraded && (
          <div className="rounded-md border border-[#FDE68A] bg-[#FFFBEB] px-3 py-2 text-xs text-[#B45309]">
            Live seat data is temporarily degraded — alerts may be delayed.
          </div>
        )}

        <div className="flex gap-2">
          <Input
            value={index}
            onChange={(e) => setIndex(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={(e) => e.key === 'Enter' && !busy && addWatch()}
            placeholder="Section index, e.g. 10634"
            inputMode="numeric"
            className="font-mono"
          />
          <Button onClick={addWatch} disabled={busy || !index.trim()} className="shrink-0">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            <span className="ml-1">Watch</span>
          </Button>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}

        {loading ? (
          <p className="text-sm text-[#6B7280]">Loading…</p>
        ) : watches.length === 0 ? (
          <p className="text-sm text-[#6B7280]">
            No sections tracked yet. Find the 5-digit index on WebReg or the Schedule of
            Classes and paste it above.
          </p>
        ) : (
          <ul className="space-y-2">
            {watches.map((w) => (
              <li
                key={w.id}
                className="flex items-center gap-3 rounded-lg bg-[#F8FAFC] px-3 py-2"
              >
                <span
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATUS_DOT[w.status]}`}
                  title={STATUS_LABEL[w.status]}
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#1F2937]">
                    <span className="font-mono">{w.section_index}</span>
                    {w.course_code && (
                      <span className="ml-2 font-mono text-xs text-[#6B7280]">
                        {w.course_code}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-[#6B7280]">
                    {STATUS_LABEL[w.status]}
                    {w.last_checked_at &&
                      ` · checked ${new Date(w.last_checked_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}`}
                  </p>
                </div>
                {w.status === 'open' && w.registerUrl && (
                  <a
                    href={w.registerUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={() => navigator.clipboard?.writeText(w.section_index).catch(() => {})}
                    className="flex shrink-0 items-center gap-1 rounded-md bg-green-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-green-700"
                  >
                    Register
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <button
                  onClick={() => removeWatch(w.id)}
                  className="shrink-0 rounded p-1 text-[#94A3B8] hover:bg-[#F1F5F9] hover:text-[#6B7280]"
                  aria-label={`Stop watching ${w.section_index}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
