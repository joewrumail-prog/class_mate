import { useState, useEffect } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { Users } from 'lucide-react'
import { authFetch } from '@/lib/api'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

interface Connection {
  connectionId: string
  connectedAt: string
  roomName?: string | null
  friend: {
    id: string
    nickname: string
    avatar_url?: string
    wechat?: string
    qq?: string
    school?: string
  } | null
}

interface ConnectionsListProps {
  userId: string
}

export function ConnectionsList({ userId }: ConnectionsListProps) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchConnections = async () => {
      try {
        const res = await authFetch(`${API_URL}/api/contacts/connections/${userId}`)
        const data = await res.json()
        if (data.success) {
          setConnections(data.connections || [])
        }
      } catch (err) {
        console.error('Failed to fetch connections:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchConnections()
  }, [userId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            My Classmates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {[1, 2, 3].map((i) => (
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

  if (connections.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Users className="h-5 w-5" />
            My Classmates
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <Users className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="text-muted-foreground">
              No connections yet.
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              Share your contact info with classmates to connect!
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          My Classmates ({connections.length})
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="space-y-4">
          {connections.map((conn) => {
            if (!conn.friend) return null
            
            return (
              <li key={conn.connectionId} className="flex items-start gap-4 pb-4 border-b last:border-b-0 last:pb-0">
                <Avatar>
                  <AvatarImage src={conn.friend.avatar_url} />
                  <AvatarFallback>
                    {conn.friend.nickname?.slice(0, 2).toUpperCase() || 'U'}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-medium">{conn.friend.nickname}</p>
                  
                  {/* Contact info */}
                  <div className="flex flex-wrap gap-2 mt-1">
                    {conn.friend.wechat && (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">
                        WeChat: {conn.friend.wechat}
                      </span>
                    )}
                    {conn.friend.qq && (
                      <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                        QQ: {conn.friend.qq}
                      </span>
                    )}
                    {!conn.friend.wechat && !conn.friend.qq && (
                      <span className="text-xs text-muted-foreground">
                        No contact info set
                      </span>
                    )}
                  </div>
                  
                  {/* Connection info */}
                  <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                    {conn.roomName && (
                      <span>Met in: {conn.roomName}</span>
                    )}
                    <span>
                      Connected {new Date(conn.connectedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
