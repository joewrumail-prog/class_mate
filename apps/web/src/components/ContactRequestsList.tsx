import { useEffect, useState } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { authFetch } from '@/lib/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

interface PendingRequest {
  id: string
  message?: string | null
  createdAt: string
  roomName?: string | null
  requester: {
    id: string
    nickname: string
    avatar_url?: string
    school?: string
  } | null
}

interface ContactRequestsListProps {
  userId: string
}

export function ContactRequestsList({ userId }: ContactRequestsListProps) {
  const [requests, setRequests] = useState<PendingRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [respondingId, setRespondingId] = useState<string | null>(null)

  const fetchRequests = async () => {
    try {
      const res = await authFetch(`${API_URL}/api/contacts/pending/${userId}`)
      const data = await res.json()
      if (data.success) {
        setRequests(data.requests || [])
      }
    } catch (err) {
      console.error('Failed to fetch contact requests:', err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchRequests()
  }, [userId])

  const respond = async (requestId: string, accept: boolean) => {
    setRespondingId(requestId)
    try {
      const res = await authFetch(`${API_URL}/api/contacts/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, userId, accept }),
      })
      const data = await res.json()
      if (!data.success) throw new Error(data.error)

      toast.success(accept ? 'Request accepted' : 'Request declined')
      setRequests((prev) => prev.filter((r) => r.id !== requestId))
    } catch (error: any) {
      toast.error(error.message || 'Failed to respond')
    } finally {
      setRespondingId(null)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Pending Requests
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-full" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    )
  }

  if (requests.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5" />
            Pending Requests
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">No pending requests.</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <UserPlus className="h-5 w-5" />
          Pending Requests ({requests.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {requests.map((req) => (
          <div key={req.id} className="flex items-start gap-4 p-3 rounded-lg border">
            <Avatar>
              <AvatarImage src={req.requester?.avatar_url} />
              <AvatarFallback>
                {req.requester?.nickname?.slice(0, 2).toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <p className="font-medium">{req.requester?.nickname || 'Unknown user'}</p>
              <p className="text-xs text-muted-foreground">
                {req.roomName ? `From ${req.roomName}` : 'Request to share contact info'}
              </p>
              {req.message && (
                <p className="text-sm text-muted-foreground mt-2">"{req.message}"</p>
              )}
              <div className="flex gap-2 mt-3">
                <Button
                  size="sm"
                  onClick={() => respond(req.id, true)}
                  loading={respondingId === req.id}
                >
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => respond(req.id, false)}
                  disabled={respondingId === req.id}
                >
                  Decline
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
