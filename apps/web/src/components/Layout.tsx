import { useState, useEffect } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { 
  Calendar, 
  LayoutDashboard, 
  Upload, 
  User, 
  LogOut,
  Bell,
  X,
  Check,
  UserPlus
} from 'lucide-react'
import { toast } from 'sonner'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000'

interface Notification {
  id: string
  type: string
  title: string
  content: string
  is_read: boolean
  created_at: string
  data?: {
    request_id?: string
    requester_id?: string
    room_id?: string
  }
}

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const { user, logout } = useAuthStore()
  const location = useLocation()
  const navigate = useNavigate()
  
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [loading, setLoading] = useState(false)
  const [responding, setResponding] = useState<string | null>(null)
  
  const navItems = [
    { path: '/dashboard', icon: LayoutDashboard, label: 'My Courses' },
    { path: '/import', icon: Upload, label: 'Import' },
    { path: '/profile', icon: User, label: 'Profile' },
  ]
  
  const isActive = (path: string) => location.pathname === path
  
  const unreadCount = notifications.filter(n => !n.is_read).length
  
  // Fetch notifications
  const fetchNotifications = async () => {
    if (!user?.id) return
    
    setLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/users/${user.id}/notifications`)
      const result = await response.json()
      
      if (result.success) {
        setNotifications(result.notifications || [])
      }
    } catch (error) {
      console.error('Failed to fetch notifications:', error)
    } finally {
      setLoading(false)
    }
  }
  
  // Mark notification as read
  const markAsRead = async (notificationId: string) => {
    if (!user?.id) return
    
    try {
      await fetch(`${API_URL}/api/users/${user.id}/notifications/${notificationId}/read`, {
        method: 'POST',
      })
      
      setNotifications(prev => 
        prev.map(n => n.id === notificationId ? { ...n, is_read: true } : n)
      )
    } catch (error) {
      console.error('Failed to mark as read:', error)
    }
  }
  
  // Mark all as read
  const markAllAsRead = async () => {
    if (!user?.id) return
    
    try {
      await fetch(`${API_URL}/api/users/${user.id}/notifications/read-all`, {
        method: 'POST',
      })
      
      setNotifications(prev => prev.map(n => ({ ...n, is_read: true })))
    } catch (error) {
      console.error('Failed to mark all as read:', error)
    }
  }

  // Handle contact request response
  const handleContactResponse = async (notificationId: string, requestId: string, accept: boolean) => {
    setResponding(notificationId)
    try {
      const response = await fetch(`${API_URL}/api/contacts/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId,
          userId: user?.id,
          accept,
        }),
      })
      
      const result = await response.json()
      if (result.success) {
        toast.success(accept ? 'Contact request accepted!' : 'Contact request declined')
        markAsRead(notificationId)
        fetchNotifications()
      } else {
        throw new Error(result.error)
      }
    } catch (error: any) {
      toast.error(error.message || 'Failed to respond')
    } finally {
      setResponding(null)
    }
  }
  
  useEffect(() => {
    fetchNotifications()
    // Poll for new notifications every 30 seconds
    const interval = setInterval(fetchNotifications, 30000)
    return () => clearInterval(interval)
  }, [user?.id])
  
  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diff = now.getTime() - date.getTime()
    
    if (diff < 60000) return 'Just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    return `${Math.floor(diff / 86400000)}d ago`
  }

  const handleLogout = async () => {
    await logout()
    navigate('/')
  }
  
  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center">
          <Link to="/dashboard" className="flex items-center gap-2 font-bold text-lg">
            <Calendar className="h-6 w-6 text-primary" />
            <span>ClassMate</span>
          </Link>
          
          <nav className="hidden md:flex items-center gap-6 ml-10">
            {navItems.map(item => (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-2 text-sm font-medium transition-colors hover:text-primary ${
                  isActive(item.path) ? 'text-primary' : 'text-muted-foreground'
                }`}
              >
                <item.icon className="h-4 w-4" />
                {item.label}
              </Link>
            ))}
          </nav>
          
          <div className="flex items-center gap-4 ml-auto">
            {/* Notification Button */}
            <div className="relative">
              <Button 
                variant="ghost" 
                size="icon" 
                className="relative"
                onClick={() => {
                  setShowNotifications(!showNotifications)
                  if (!showNotifications) {
                    fetchNotifications()
                  }
                }}
              >
                <Bell className="h-5 w-5" />
                {unreadCount > 0 && (
                  <span className="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-destructive text-[10px] font-medium text-destructive-foreground flex items-center justify-center">
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Button>
              
              {/* Notification Dropdown */}
              {showNotifications && (
                <div className="absolute right-0 top-full mt-2 w-80 bg-background border rounded-lg shadow-lg z-50">
                  <div className="flex items-center justify-between p-3 border-b">
                    <h3 className="font-semibold">Notifications</h3>
                    <div className="flex items-center gap-2">
                      {unreadCount > 0 && (
                        <button 
                          onClick={markAllAsRead}
                          className="text-xs text-primary hover:underline"
                        >
                          Mark all read
                        </button>
                      )}
                      <button onClick={() => setShowNotifications(false)}>
                        <X className="h-4 w-4 text-muted-foreground" />
                      </button>
                    </div>
                  </div>
                  
                  <div className="max-h-80 overflow-y-auto">
                    {loading ? (
                      <div className="p-4 text-center text-muted-foreground">
                        Loading...
                      </div>
                    ) : notifications.length === 0 ? (
                      <div className="p-4 text-center text-muted-foreground">
                        No notifications
                      </div>
                    ) : (
                      notifications.map(notification => (
                        <div
                          key={notification.id}
                          className={`p-3 border-b hover:bg-muted/50 ${
                            !notification.is_read ? 'bg-primary/5' : ''
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            {!notification.is_read && (
                              <div className="w-2 h-2 rounded-full bg-primary mt-2 flex-shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                {notification.type === 'contact_request' && (
                                  <UserPlus className="h-4 w-4 text-primary" />
                                )}
                                <p className="font-medium text-sm">{notification.title}</p>
                              </div>
                              <p className="text-sm text-muted-foreground">
                                {notification.content}
                              </p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {formatTime(notification.created_at)}
                              </p>
                              
                              {/* Action buttons for contact requests */}
                              {notification.type === 'contact_request' && notification.data?.request_id && (
                                <div className="flex gap-2 mt-2">
                                  <Button
                                    size="sm"
                                    variant="default"
                                    className="h-7 text-xs"
                                    disabled={responding === notification.id}
                                    onClick={() => handleContactResponse(
                                      notification.id,
                                      notification.data!.request_id!,
                                      true
                                    )}
                                  >
                                    <Check className="h-3 w-3 mr-1" />
                                    Accept
                                  </Button>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    className="h-7 text-xs"
                                    disabled={responding === notification.id}
                                    onClick={() => handleContactResponse(
                                      notification.id,
                                      notification.data!.request_id!,
                                      false
                                    )}
                                  >
                                    <X className="h-3 w-3 mr-1" />
                                    Decline
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
            
            <div className="flex items-center gap-3">
              <Avatar className="h-8 w-8">
                <AvatarImage src={user?.avatar_url} />
                <AvatarFallback>
                  {user?.nickname?.charAt(0).toUpperCase() || 'U'}
                </AvatarFallback>
              </Avatar>
              <div className="hidden md:block">
                <p className="text-sm font-medium">{user?.nickname}</p>
                {user?.is_edu_email && (
                  <p className="text-xs text-green-600">Verified Student</p>
                )}
              </div>
            </div>
            
            <Button variant="ghost" size="icon" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>
      
      {/* Click outside to close notifications */}
      {showNotifications && (
        <div 
          className="fixed inset-0 z-40" 
          onClick={() => setShowNotifications(false)}
        />
      )}
      
      {/* Mobile nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-50 border-t bg-background">
        <div className="flex justify-around py-2">
          {navItems.map(item => (
            <Link
              key={item.path}
              to={item.path}
              className={`flex flex-col items-center gap-1 p-2 ${
                isActive(item.path) ? 'text-primary' : 'text-muted-foreground'
              }`}
            >
              <item.icon className="h-5 w-5" />
              <span className="text-xs">{item.label}</span>
            </Link>
          ))}
        </div>
      </nav>
      
      {/* Main content */}
      <main className="container py-6 pb-20 md:pb-6">
        {children}
      </main>
    </div>
  )
}
