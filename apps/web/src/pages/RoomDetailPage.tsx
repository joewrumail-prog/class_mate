import { useState, useEffect, useCallback } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { PrivacyDialog } from '@/components/PrivacyDialog'
import { ArrowLeft, Users, Calendar, MapPin, User, MessageCircle, Lock, Clock, Check, X } from 'lucide-react'
import { toast } from 'sonner'
import { formatSemesterId } from '@/lib/semester'
import { authFetch } from '@/lib/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

interface Member {
  id: string
  nickname: string
  avatar?: string
  wechat?: string | null
  qq?: string | null
  joinedAt: string
  contactStatus: 'visible' | 'pending' | 'rejected' | 'hidden'
  isConnected: boolean
}

interface RoomData {
  id: string
  courseName: string
  courseCode: string
  school?: string
  semester: string
  dayOfWeek: number
  startTime: string
  endTime: string
  professor: string
  classroom: string
  weeks?: string
  memberCount: number
}

interface OtherSection {
  id: string
  professor: string
  day_of_week: number
  start_time: string
  member_count: number
}

const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export default function RoomDetailPage() {
  const { roomId } = useParams()
  const { user } = useAuthStore()
  
  const [room, setRoom] = useState<RoomData | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [otherSections, setOtherSections] = useState<OtherSection[]>([])
  const [loading, setLoading] = useState(true)
  const [showPrivacyDialog, setShowPrivacyDialog] = useState(false)
  const [requestingContact, setRequestingContact] = useState<string | null>(null)

  const fetchRoomData = useCallback(async () => {
    if (!roomId) return
    
    try {
      const url = user?.id 
        ? `${API_URL}/api/rooms/${roomId}?userId=${user.id}`
        : `${API_URL}/api/rooms/${roomId}`
      
      const res = await authFetch(url)
      const data = await res.json()
      
      if (data.success) {
        setRoom(data.room)
        setMembers(data.members || [])
        setOtherSections(data.otherSections || [])
      }
    } catch (err) {
      console.error('Failed to fetch room:', err)
      toast.error('Failed to load room details')
    } finally {
      setLoading(false)
    }
  }, [roomId, user?.id])

  // Check if user needs to set privacy for this room
  const checkPrivacySetting = useCallback(async () => {
    if (!roomId || !user?.id) return
    
    // First check if user has auto_share_contact enabled
    if (user.auto_share_contact) return
    
    try {
      const res = await authFetch(`${API_URL}/api/rooms/${roomId}/privacy/${user.id}`)
      const data = await res.json()
      
      if (data.success && !data.hasSet) {
        // User hasn't set privacy for this room yet, show dialog
        setShowPrivacyDialog(true)
      }
    } catch (err) {
      console.error('Failed to check privacy setting:', err)
    }
  }, [roomId, user?.id, user?.auto_share_contact])

  useEffect(() => {
    fetchRoomData()
  }, [fetchRoomData])

  useEffect(() => {
    if (!loading && room) {
      checkPrivacySetting()
    }
  }, [loading, room, checkPrivacySetting])

  const handlePrivacyChoice = async (isPublic: boolean) => {
    if (!roomId || !user?.id) return
    
    try {
      const res = await authFetch(`${API_URL}/api/rooms/${roomId}/privacy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, isPublic }),
      })
      
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      
      toast.success(isPublic ? 'Contact info shared with classmates' : 'Contact info kept private')
      
      // Refresh room data to update visibility
      fetchRoomData()
    } catch (err: any) {
      toast.error(err.message || 'Failed to save setting')
      throw err
    }
  }

  const handleRequestContact = async (targetUserId: string) => {
    if (!user?.id) return
    
    setRequestingContact(targetUserId)
    try {
      const res = await authFetch(`${API_URL}/api/contacts/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesterId: user.id,
          targetId: targetUserId,
          roomId,
        }),
      })
      
      const data = await res.json()
      if (!data.success) throw new Error(data.error)
      
      toast.success('Request sent! They will be notified.')
      
      // Update local state
      setMembers(prev => prev.map(m => 
        m.id === targetUserId ? { ...m, contactStatus: 'pending' as const } : m
      ))
    } catch (err: any) {
      toast.error(err.message || 'Failed to send request')
    } finally {
      setRequestingContact(null)
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-10 w-10" />
          <div>
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-32 mt-1" />
          </div>
        </div>
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!room) {
    return (
      <div className="max-w-3xl mx-auto text-center py-12">
        <h2 className="text-xl font-semibold mb-2">Room Not Found</h2>
        <p className="text-muted-foreground mb-4">This room may have been deleted or doesn't exist.</p>
        <Button asChild>
          <Link to="/dashboard">Go to Dashboard</Link>
        </Button>
      </div>
    )
  }
  
  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Privacy Dialog */}
      <PrivacyDialog
        open={showPrivacyDialog}
        onOpenChange={setShowPrivacyDialog}
        roomName={room.courseName}
        onConfirm={handlePrivacyChoice}
      />

      {/* Header */}
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" asChild>
          <Link to="/dashboard">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-bold">{room.courseName}</h1>
          <p className="text-muted-foreground">
            {room.courseCode ? `${room.courseCode} - ${formatSemesterId(room.semester)}` : formatSemesterId(room.semester)}
          </p>
        </div>
      </div>
      
      {/* Course Info */}
      <Card>
        <CardContent className="pt-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <span>{dayNames[room.dayOfWeek]} {room.startTime}-{room.endTime}</span>
            </div>
            <div className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-muted-foreground" />
              <span>{room.classroom || 'TBA'}</span>
            </div>
            <div className="flex items-center gap-2">
              <User className="h-4 w-4 text-muted-foreground" />
              <span>{room.professor || 'TBA'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <span>{members.length} classmate{members.length !== 1 ? 's' : ''}</span>
            </div>
          </div>
        </CardContent>
      </Card>
      
      {/* Members */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            Classmates
          </CardTitle>
          <CardDescription>
            Sorted by join date
          </CardDescription>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No classmates yet. Share this room to find study buddies!
            </p>
          ) : (
            <div className="space-y-4">
              {members.map((member) => {
                const isMe = member.id === user?.id
                
                return (
                  <div 
                    key={member.id} 
                    className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                  >
                    <div className="flex items-center gap-3">
                      <Avatar>
                        <AvatarImage src={member.avatar || undefined} />
                        <AvatarFallback>
                          {member.nickname.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-medium">{member.nickname}</p>
                          {isMe && <Badge variant="outline">You</Badge>}
                          {member.isConnected && !isMe && (
                            <Badge variant="secondary" className="bg-green-100 text-green-700">
                              Connected
                            </Badge>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Joined {new Date(member.joinedAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {member.contactStatus === 'visible' ? (
                        // Contact info visible
                        <>
                          {member.wechat && (
                            <div className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
                              WeChat: {member.wechat}
                            </div>
                          )}
                          {member.qq && (
                            <div className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded">
                              QQ: {member.qq}
                            </div>
                          )}
                          {!member.wechat && !member.qq && (
                            <div className="text-xs text-muted-foreground">
                              No contact info set
                            </div>
                          )}
                        </>
                      ) : member.contactStatus === 'pending' ? (
                        // Request pending
                        <div className="flex items-center gap-1 text-xs text-amber-600">
                          <Clock className="h-3 w-3" />
                          Request pending
                        </div>
                      ) : member.contactStatus === 'rejected' ? (
                        // Recently rejected
                        <div className="flex items-center gap-1 text-xs text-red-500">
                          <X className="h-3 w-3" />
                          Request declined
                        </div>
                      ) : !isMe ? (
                        // Can request
                        <Button 
                          size="sm" 
                          variant="outline"
                          loading={requestingContact === member.id}
                          onClick={() => handleRequestContact(member.id)}
                        >
                          <Lock className="h-3 w-3 mr-1" />
                          Request Contact
                        </Button>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* Other Sections */}
      {otherSections.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MessageCircle className="h-5 w-5" />
              Other Sections
            </CardTitle>
            <CardDescription>
              Same course, different times - great for study groups
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {otherSections.map((section) => (
                <div 
                  key={section.id}
                  className="flex items-center justify-between p-3 rounded-lg border"
                >
                  <div>
                    <p className="font-medium">{section.professor || 'TBA'}</p>
                    <p className="text-sm text-muted-foreground">
                      {dayNames[section.day_of_week]} {section.start_time}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {section.member_count} member{section.member_count !== 1 ? 's' : ''}
                    </span>
                    <Button size="sm" variant="outline" asChild>
                      <Link to={`/room/${section.id}`}>View</Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
