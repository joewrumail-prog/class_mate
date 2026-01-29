import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { CourseSearchBox } from '@/components/CourseSearchBox'
import { getCurrentSemester, formatSemesterId } from '@/lib/semester'
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
    <div className="space-y-6">
      {/* Course Search */}
      <div className="bg-gradient-to-r from-primary/10 to-primary/5 rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-3">Find Your Classmates</h2>
        <CourseSearchBox semester={currentSemester.id} />
        <p className="text-xs text-muted-foreground mt-2">
          Search by course code (e.g. 01:198:111) or section index
        </p>
      </div>

      {/* Welcome */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hi, {user?.nickname}</h1>
          <p className="text-muted-foreground">
            {currentSemester.display} - Rutgers New Brunswick
          </p>
        </div>
        <Button asChild>
          <Link to="/import">
            <Upload className="mr-2 h-4 w-4" />
            Import Schedule
          </Link>
        </Button>
      </div>
      
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-2 rounded-lg bg-primary/10">
                <Calendar className="h-5 w-5 text-primary" />
              </div>
              <div>
                {loading ? (
                  <Skeleton className="h-8 w-12" />
                ) : (
                  <p className="text-2xl font-bold">{rooms.length}</p>
                )}
                <p className="text-xs text-muted-foreground">Courses</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="p-2 rounded-lg bg-green-500/10">
                <Users className="h-5 w-5 text-green-500" />
              </div>
              <div>
                {loading ? (
                  <Skeleton className="h-8 w-12" />
                ) : (
                  <p className="text-2xl font-bold">{Math.max(0, totalClassmates)}</p>
                )}
                <p className="text-xs text-muted-foreground">Classmates</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
      
      {/* Rooms */}
      {loading ? (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">My Courses</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
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
        <Card className="border-dashed">
          <CardContent className="py-12 text-center">
            <Upload className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <h3 className="font-semibold mb-2">No Schedule Imported Yet</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Upload a screenshot of your schedule to find classmates
            </p>
            <Button asChild>
              <Link to="/import">
                Import Schedule
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">My Courses</h2>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {rooms.map((room) => (
              <Card key={room.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <CardTitle className="text-lg">{room.courseName}</CardTitle>
                  <CardDescription>
                    {dayNames[room.dayOfWeek]} {room.startTime}-{room.endTime}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-1 text-sm text-muted-foreground mb-4">
                    <p>Location: {room.classroom || 'TBA'}</p>
                    <p>Professor: {room.professor || 'TBA'}</p>
                  </div>
                  
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" />
                      <span className={room.memberCount > 1 ? 'text-green-600 font-medium' : 'text-muted-foreground'}>
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
  )
}
