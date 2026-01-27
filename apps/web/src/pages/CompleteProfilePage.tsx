import { useEffect, useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { isEduEmail } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Calendar, GraduationCap } from 'lucide-react'
import { toast } from 'sonner'

const PENDING_PROFILE_KEY = 'classmate-pending-profile'

interface PendingProfile {
  email?: string
  nickname?: string
  wechat?: string
  qq?: string
}

export default function CompleteProfilePage() {
  const navigate = useNavigate()
  const { user, refreshUser } = useAuthStore()

  const [loading, setLoading] = useState(false)
  const [formData, setFormData] = useState({
    nickname: user?.nickname || '',
    wechat: '',
    qq: '',
  })

  useEffect(() => {
    if (!user) return
    if (user.profile_complete) {
      navigate('/dashboard', { replace: true })
      return
    }

    const raw = localStorage.getItem(PENDING_PROFILE_KEY)
    if (!raw) return

    try {
      const pending = JSON.parse(raw) as PendingProfile
      setFormData((prev) => ({
        nickname: prev.nickname || pending.nickname || user.nickname || '',
        wechat: prev.wechat || pending.wechat || '',
        qq: prev.qq || pending.qq || '',
      }))
    } catch {
      // Ignore malformed storage
    }
  }, [navigate, user])

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-muted/20">
        <Card className="w-full max-w-md text-center">
          <CardHeader>
            <CardTitle>Please sign in</CardTitle>
            <CardDescription>You need to be signed in to complete your profile.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild className="w-full">
              <Link to="/login">Go to Login</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!formData.nickname || formData.nickname.length < 2) {
      toast.error('Nickname must be at least 2 characters')
      return
    }

    setLoading(true)
    try {
      const isEdu = isEduEmail(user.email)

      const { error } = await supabase
        .from('users')
        .upsert(
          {
            id: user.id,
            email: user.email,
            nickname: formData.nickname,
            wechat: formData.wechat || null,
            qq: formData.qq || null,
            school: 'Rutgers University - New Brunswick',
            is_edu_email: isEdu,
            email_verified: user.email_verified,
            auto_share_contact: false,
          },
          { onConflict: 'id' }
        )

      if (error) throw error

      localStorage.removeItem(PENDING_PROFILE_KEY)
      await refreshUser()
      toast.success('Profile completed!')
      navigate('/dashboard')
    } catch (error: any) {
      toast.error(error.message || 'Failed to save profile')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-muted/20">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <Link to="/" className="flex items-center justify-center gap-2 mb-4">
            <Calendar className="h-8 w-8 text-primary" />
            <span className="font-bold text-2xl">ClassMate</span>
          </Link>
          <CardTitle>Complete Your Profile</CardTitle>
          <CardDescription>Finish setup to start finding classmates</CardDescription>
        </CardHeader>

        <CardContent>
          <div className="mb-4 p-3 bg-primary/10 rounded-lg flex items-center gap-2 text-sm">
            <GraduationCap className="h-5 w-5 text-primary flex-shrink-0" />
            <span>
              ClassMate is currently available for <strong>Rutgers University - New Brunswick</strong> students only.
            </span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="nickname">Nickname *</Label>
              <Input
                id="nickname"
                placeholder="Your display name"
                value={formData.nickname}
                onChange={(e) => setFormData({ ...formData, nickname: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="wechat">WeChat ID (optional)</Label>
              <Input
                id="wechat"
                placeholder="For classmates to add you"
                value={formData.wechat}
                onChange={(e) => setFormData({ ...formData, wechat: e.target.value })}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="qq">QQ Number (optional)</Label>
              <Input
                id="qq"
                placeholder="For classmates to add you"
                value={formData.qq}
                onChange={(e) => setFormData({ ...formData, qq: e.target.value })}
              />
            </div>

            <Button type="submit" className="w-full" loading={loading}>
              Complete Profile
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
