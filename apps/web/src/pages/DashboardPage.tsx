import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { CourseSearchBox } from '@/components/CourseSearchBox'
import { getCurrentSemester } from '@/lib/semester'
import { authFetch } from '@/lib/api'
import { Upload, Users, Calendar, ArrowRight } from 'lucide-react'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

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

export default function DashboardPage() {
  const { user } = useAuthStore()
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const currentSemester = getCurrentSemester()
  
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
  
  const hasRooms = rooms.length > 0
  const totalClassmates = rooms.reduce(
    (acc, r) => acc + Math.max(0, Number(r.memberCount ?? 0) - 1),
    0
  )
  
  return (
    <div className="min-h-screen bg-[#F8FAFC] py-10">
      <div className="max-w-6xl mx-auto px-4 md:px-6 space-y-8">
        {/* Welcome */}
        <div className="flex flex-col gap-4 rounded-2xl border border-[#E2E8F0] bg-white p-6 shadow-[0_8px_20px_-12px_rgba(15,23,42,0.35)] md:flex-row md:items-center md:justify-between">
          <div className="space-y-1">
            <p className="text-sm text-[#6B7280]">{currentSemester.display} · Rutgers New Brunswick</p>
            <h1 className="text-2xl font-semibold text-[#1F2937]">Welcome back, {user?.nickname}</h1>
            <p className="text-sm text-[#6B7280]">Stay on top of your classes and meet classmates.</p>
          </div>
          <Button className="bg-[#1E40AF] text-white hover:bg-[#1E40AF]/90" asChild>
            <Link to="/import">
              <Upload className="mr-2 h-4 w-4" />
              Import Schedule
            </Link>
          </Button>
        </div>

        {/* Course Search */}
        <div className="rounded-2xl border border-[#E2E8F0] bg-[radial-gradient(circle_at_top,#EFF6FF_0%,#FFFFFF_55%)] p-6 shadow-[0_8px_20px_-12px_rgba(15,23,42,0.35)]">
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-medium text-[#1F2937]">Find Your Classmates</h2>
            <p className="text-sm text-[#6B7280]">Search by course code (01:198:111) or section index.</p>
          </div>
          <div className="mt-4">
            <CourseSearchBox semester={currentSemester.id} />
          </div>
        </div>
      
      {/* Stats */}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <Card className="border-[#E2E8F0] shadow-sm">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 rounded-lg bg-[#1E40AF]/10">
                  <Calendar className="h-5 w-5 text-[#1E40AF]" />
                </div>
                <div>
                  {loading ? (
                    <Skeleton className="h-8 w-12" />
                  ) : (
                    <p className="text-2xl font-semibold text-[#1F2937]">{rooms.length}</p>
                  )}
                  <p className="text-xs text-[#6B7280]">Courses</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="border-[#E2E8F0] shadow-sm">
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <div className="p-2 rounded-lg bg-[#0D9488]/10">
                  <Users className="h-5 w-5 text-[#0D9488]" />
                </div>
                <div>
                  {loading ? (
                    <Skeleton className="h-8 w-12" />
                  ) : (
                    <p className="text-2xl font-semibold text-[#1F2937]">{Math.max(0, totalClassmates)}</p>
                  )}
                  <p className="text-xs text-[#6B7280]">Classmates</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      
      {/* Rooms */}
        {loading ? (
          <div className="space-y-4">
            <h2 className="text-lg font-medium text-[#1F2937]">My Courses</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="border-[#E2E8F0]">
                  <CardHeader className="pb-2">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-4 w-24" />
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-2 mb-4">
                      <Skeleton className="h-4 w-28" />
                      <Skeleton className="h-4 w-20" />
                    </div>
                    <Skeleton className="h-8 w-full" />
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        ) : !hasRooms ? (
          <Card className="border-dashed border-[#E2E8F0] bg-white">
            <CardContent className="py-12 text-center">
              <Upload className="h-12 w-12 text-[#6B7280] mx-auto mb-4" />
              <h3 className="font-semibold text-[#1F2937] mb-2">No Schedule Imported Yet</h3>
              <p className="text-sm text-[#6B7280] mb-4">
                Upload a screenshot of your schedule to find classmates
              </p>
              <Button className="bg-[#1E40AF] text-white hover:bg-[#1E40AF]/90" asChild>
                <Link to="/import">
                  Import Schedule
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            <h2 className="text-lg font-medium text-[#1F2937]">My Courses</h2>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {rooms.map((room) => (
                <Card key={room.id} className="border-[#E2E8F0] transition-all hover:-translate-y-0.5 hover:shadow-md">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-lg text-[#1F2937]">{room.courseName}</CardTitle>
                    <CardDescription className="text-[#6B7280]">
                      {dayNames[room.dayOfWeek]} {room.startTime}-{room.endTime}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1 text-sm text-[#6B7280] mb-4">
                      <p>Location: {room.classroom || 'TBA'}</p>
                      <p>Professor: {room.professor || 'TBA'}</p>
                    </div>
                    
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-[#0D9488]" />
                        <span className={room.memberCount > 1 ? 'text-[#0D9488] font-medium' : 'text-[#6B7280]'}>
                          {room.memberCount > 1 
                            ? `${room.memberCount - 1} classmate${room.memberCount > 2 ? 's' : ''}` 
                            : 'No classmates yet'}
                        </span>
                      </div>
                      <Button size="sm" variant={room.memberCount > 1 ? 'default' : 'outline'} asChild>
                        <Link to={`/room/${room.id}`}>
                          {room.memberCount > 1 ? 'View' : 'Waiting'}
                        </Link>
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
