import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { UserPlus } from 'lucide-react'
import { authFetch } from '@/lib/api'

const API_URL = '' // same-origin: dev proxy + Vercel rewrites

interface OverlapRoom {
  roomId: string
  courseName: string
  courseCode: string | null
}

interface OverlapClassmate {
  userId: string
  firstName: string
  avatarUrl: string | null
  sharedCourses: number
  rooms: OverlapRoom[]
}

interface OverlapData {
  totalCourses: number
  overlappingCourses: number
  classmates: OverlapClassmate[]
  firstCourseCode: string | null
  inviteCode: string | null
}

const MAX_VISIBLE_CLASSMATES = 6

/**
 * Post-import "overlap reveal" — the conversion moment. Shown full-screen
 * after a successful schedule import, BEFORE the dashboard, so a new user
 * sees people before they see the planner. Fetches /api/schedule/overlap
 * itself; on any fetch failure it renders nothing and closes immediately so
 * the user is never trapped. Privacy (shared API contract): avatar, first
 * name, counts, and shared room list only — no schedules or contact info.
 * Flag-independent: renders the same with system_ui on or off.
 */
export default function OverlapReveal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [data, setData] = useState<OverlapData | null>(null)
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const copiedTimerRef = useRef<number | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    let cancelled = false

    const fetchOverlap = async () => {
      try {
        const response = await authFetch(`${API_URL}/api/schedule/overlap`)
        const result = await response.json()

        if (!result.success) {
          throw new Error(result.error || 'Overlap fetch failed')
        }

        if (!cancelled) {
          setData({
            totalCourses: result.totalCourses,
            overlappingCourses: result.overlappingCourses,
            classmates: result.classmates || [],
            firstCourseCode: result.firstCourseCode ?? null,
            inviteCode: result.inviteCode ?? null,
          })
        }
      } catch (error) {
        console.error('Overlap fetch error:', error)
        // Never trap the user behind a broken reveal.
        if (!cancelled) {
          setFailed(true)
          onCloseRef.current()
        }
      }
    }

    fetchOverlap()
    return () => {
      cancelled = true
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current)
      }
    }
  }, [])

  const handleInvite = async () => {
    const link = `${window.location.origin}/register${
      data?.inviteCode ? `?ref=${data.inviteCode}` : ''
    }`
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      if (copiedTimerRef.current !== null) {
        window.clearTimeout(copiedTimerRef.current)
      }
      copiedTimerRef.current = window.setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Clipboard error:', error)
    }
  }

  if (failed) return null

  const loading = data === null
  const classmates = data?.classmates ?? []
  const visibleClassmates = classmates.slice(0, MAX_VISIBLE_CLASSMATES)
  const hiddenCount = classmates.length - visibleClassmates.length

  const headline = loading
    ? 'Finding your classmates...'
    : classmates.length > 0
      ? `${data.overlappingCourses} of your classes ${
          data.overlappingCourses === 1 ? 'overlaps' : 'overlap'
        } with ${classmates.length} ${classmates.length === 1 ? 'person' : 'people'}`
      : 'You are the first one here'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Classmate overlap"
      className="fixed inset-0 z-[90] overflow-y-auto bg-[#F8FAFC]"
    >
      {/* Brand gradient wash header */}
      <div className="bg-[linear-gradient(135deg,var(--brand-800),var(--brand-900))] px-4 pb-20 pt-12 text-center">
        <p className="font-mono text-[11px] font-bold uppercase tracking-[.22em] text-white/70">
          Schedule imported
        </p>
        <h1 className="mx-auto mt-3 max-w-xl text-2xl font-semibold text-white">{headline}</h1>
      </div>

      <div className="mx-auto -mt-12 w-full max-w-md px-4 pb-12">
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center gap-3 rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-card"
              >
                <Skeleton className="h-10 w-10 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-8 w-32 rounded-md" />
              </div>
            ))}
          </div>
        ) : classmates.length > 0 ? (
          <>
            <div className="cm-pop space-y-3">
              {visibleClassmates.map((mate) => (
                <div
                  key={mate.userId}
                  className="flex items-center gap-3 rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-card"
                >
                  {mate.avatarUrl ? (
                    <img
                      src={mate.avatarUrl}
                      alt=""
                      className="h-10 w-10 flex-none rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-brand-100 text-sm font-bold text-brand-900">
                      {mate.firstName.charAt(0).toUpperCase() || 'U'}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-[#1F2937]">{mate.firstName}</p>
                    <p className="text-xs font-medium text-[#0D9488]">
                      {mate.sharedCourses} shared {mate.sharedCourses === 1 ? 'class' : 'classes'}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    className="flex-none bg-brand-800 text-white hover:bg-brand-hover"
                    onClick={() => {
                      const roomId = mate.rooms[0]?.roomId
                      if (roomId) navigate(`/room/${roomId}`)
                    }}
                  >
                    Say hi in the room
                  </Button>
                </div>
              ))}
              {hiddenCount > 0 && (
                <p className="text-center text-xs text-[#6B7280]">
                  +{hiddenCount} more {hiddenCount === 1 ? 'classmate' : 'classmates'}
                </p>
              )}
            </div>
            <div className="mt-6 text-center">
              <Button variant="outline" onClick={onClose}>
                Later
              </Button>
            </div>
          </>
        ) : (
          <div className="cm-pop rounded-xl border-2 border-dashed border-brand-200 bg-white p-6 text-center shadow-card">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-brand-100">
              <UserPlus className="h-6 w-6 text-brand-900" />
            </div>
            <h2 className="mt-4 text-base font-semibold text-[#1F2937]">
              You are first from {data.firstCourseCode ?? 'your classes'}
            </h2>
            <p className="mt-1 text-sm text-[#6B7280]">
              We will ping you when classmates arrive.
            </p>
            <Button
              className="mt-5 w-full bg-brand-800 text-white hover:bg-brand-hover"
              onClick={handleInvite}
            >
              {copied ? 'Link copied!' : 'Invite classmates'}
            </Button>
            <Button variant="outline" className="mt-3 w-full" onClick={onClose}>
              Go to dashboard
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
