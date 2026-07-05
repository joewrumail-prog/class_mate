import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatSemesterId } from '@/lib/semester'
import { authFetch } from '@/lib/api'
import { Calendar, MapPin, Upload } from 'lucide-react'

const API_URL = '' // same-origin: dev proxy + Vercel rewrites

interface Room {
  id: string
  courseName: string
  courseCode?: string
  dayOfWeek: number
  startTime: string
  endTime: string
  professor: string
  classroom: string
  weeks?: string
  memberCount: number
  semester?: string
}

const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function classmateCount(room: Room) {
  return Math.max(0, Number(room.memberCount ?? 0) - 1)
}

export default function RoomsPage() {
  const { user } = useAuthStore()
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchRooms = async () => {
      if (!user?.id) {
        setRooms([])
        setLoading(false)
        return
      }

      try {
        const res = await authFetch(`${API_URL}/api/rooms/my/${user.id}`)
        const data = await res.json()
        if (data.success) {
          setRooms(data.rooms || [])
        }
      } catch (err) {
        console.error('Failed to fetch rooms:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchRooms()
  }, [user?.id])

  return (
    <div className="min-h-screen bg-[#F8FAFC] py-10">
      <div className="max-w-6xl mx-auto px-4 md:px-6 space-y-[18px]">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.01em] text-[#1F2937]">Rooms</h1>
          <p className="mt-1 text-sm text-[#6B7280]">
            One room per course section — your classmates are already here.
          </p>
        </div>

        {loading ? (
          <div className="grid gap-[18px] md:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="flex flex-col gap-3 rounded-xl border border-[#E2E8F0] bg-white px-5 py-[18px] shadow-sm"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-5 w-44" />
                  </div>
                  <Skeleton className="h-6 w-24 rounded-full" />
                </div>
                <Skeleton className="h-4 w-52" />
                <div className="flex items-center justify-between border-t border-[#F1F5F9] pt-3">
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-8 w-24 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        ) : rooms.length === 0 ? (
          <div className="flex justify-center py-8">
            <div className="max-w-[420px] rounded-2xl border border-dashed border-[#CBD5E1] bg-white px-10 py-12 text-center">
              <h2 className="text-[19px] font-bold tracking-[-0.01em] text-[#1F2937]">
                No rooms yet
              </h2>
              <p className="mx-auto mt-1.5 mb-[22px] text-[13.5px] leading-relaxed text-[#6B7280]">
                Import your schedule and ClassMate joins one room per course section — your
                classmates are already there.
              </p>
              <Button className="bg-brand-800 text-white hover:bg-brand-hover" asChild>
                <Link to="/import">
                  <Upload className="mr-2 h-4 w-4" />
                  Import Schedule
                </Link>
              </Button>
            </div>
          </div>
        ) : (
          <div className="grid gap-[18px] md:grid-cols-2">
            {rooms.map((room) => {
              const classmates = classmateCount(room)
              const classmateLabel = `${classmates} classmate${classmates === 1 ? '' : 's'}`
              const code =
                room.courseCode || (room.semester ? formatSemesterId(room.semester) : '—')

              return (
                <div
                  key={room.id}
                  className="flex flex-col gap-3 rounded-xl border border-[#E2E8F0] bg-white px-5 py-[18px] shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-[11px] text-[#6B7280]">{code}</p>
                      <h2 className="mt-[3px] text-[16.5px] font-bold leading-snug tracking-[-0.01em] text-[#1F2937]">
                        {room.courseName}
                      </h2>
                    </div>
                    <span className="flex-none rounded-full border border-[#CCFBF1] bg-[#F0FDFA] px-[9px] py-[3px] text-[11px] font-semibold text-[#0F766E]">
                      {classmateLabel}
                    </span>
                  </div>

                  <div className="flex items-center gap-3.5 text-[12.5px] text-[#6B7280]">
                    <span className="inline-flex items-center gap-[5px]">
                      <Calendar className="h-[13px] w-[13px] text-[#94A3B8]" />
                      {dayNames[room.dayOfWeek]}{' '}
                      <span className="font-mono">
                        {room.startTime}-{room.endTime}
                      </span>
                    </span>
                    <span className="inline-flex items-center gap-[5px]">
                      <MapPin className="h-[13px] w-[13px] text-[#94A3B8]" />
                      {room.classroom || 'TBA'}
                    </span>
                  </div>

                  <div className="mt-auto flex items-center justify-between border-t border-[#F1F5F9] pt-3">
                    <span className="text-[12.5px] text-[#6B7280]">
                      <strong className="font-semibold text-[#374151]">{classmates}</strong>{' '}
                      classmate{classmates === 1 ? '' : 's'}
                    </span>
                    <Link
                      to={`/room/${room.id}`}
                      className="rounded-md border border-brand-200 bg-brand-50 px-3.5 py-2 text-[12.5px] font-bold text-brand-900 transition-colors hover:bg-brand-100"
                    >
                      Open Room
                    </Link>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
