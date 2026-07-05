import { useState, useEffect } from 'react'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/lib/supabase'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { ConnectionsList } from '@/components/ConnectionsList'
import { ContactRequestsList } from '@/components/ContactRequestsList'
import { toast } from 'sonner'
import { Copy } from 'lucide-react'
import { authFetch } from '@/lib/api'
import { SCHOOLS, applySchoolTheme } from '@/lib/schools'

interface ReferralStatus {
  code: string
  required: number
  qualifiedCount: number
  unlocked: boolean
  justUnlocked: boolean
}

export default function ProfilePage() {
  const { user, refreshUser } = useAuthStore()
  
  const [loading, setLoading] = useState(false)
  const [autoShareLoading, setAutoShareLoading] = useState(false)
  const [autoShareContact, setAutoShareContact] = useState(user?.auto_share_contact ?? false)
  const [formData, setFormData] = useState({
    nickname: user?.nickname || '',
    wechat: user?.wechat || '',
    qq: user?.qq || '',
    inviteCode: user?.invite_code || '',
  })

  // System UI (beta) settings
  const [systemUi, setSystemUi] = useState(!!user?.settings?.system_ui)
  const [systemUiLoading, setSystemUiLoading] = useState(false)
  const [schoolId, setSchoolId] = useState(user?.settings?.school_id ?? '')
  const [schoolLoading, setSchoolLoading] = useState(false)

  // Sync auto_share_contact when user changes
  useEffect(() => {
    setAutoShareContact(user?.auto_share_contact ?? false)
  }, [user?.auto_share_contact])

  // Sync system settings when user changes
  useEffect(() => {
    setSystemUi(!!user?.settings?.system_ui)
    setSchoolId(user?.settings?.school_id ?? '')
  }, [user?.settings?.system_ui, user?.settings?.school_id])

  // Referral program status (also lazily mints my invite code server-side)
  const [referral, setReferral] = useState<ReferralStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const loadReferralStatus = async () => {
      try {
        const res = await authFetch('/api/referral/status')
        const data = await res.json()
        if (!cancelled && data.success) {
          setReferral(data)
          if (data.justUnlocked) {
            toast.success('Seat Watch Unlimited unlocked for this semester!')
          }
        }
      } catch {
        // Non-blocking — the card degrades gracefully when status is unavailable.
      }
    }
    loadReferralStatus()
    return () => {
      cancelled = true
    }
  }, [])

  const handleCopyInviteLink = async () => {
    if (!referral?.code) return
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/register?ref=${referral.code}`
      )
      toast.success('Invite link copied')
    } catch {
      toast.error('Could not copy the link')
    }
  }

  const postSystemSettings = async (patch: { system_ui?: boolean; school_id?: string | null }) => {
    const res = await authFetch('/api/system/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const data = await res.json()
    if (!data.success) throw new Error(data.error || 'Failed to update settings')
  }

  const handleSystemUiToggle = async (checked: boolean) => {
    setSystemUiLoading(true)
    try {
      await postSystemSettings({ system_ui: checked })
      setSystemUi(checked)
      applySchoolTheme(checked ? schoolId || null : null)
      await useAuthStore.getState().refreshUser()
      toast.success(checked ? 'System UI enabled' : 'System UI disabled')
    } catch (error: any) {
      toast.error(error.message || 'Failed to update setting')
    } finally {
      setSystemUiLoading(false)
    }
  }

  const handleSchoolChange = async (value: string) => {
    const previous = schoolId
    const newId = value || null
    setSchoolId(value)
    setSchoolLoading(true)
    try {
      await postSystemSettings({ school_id: newId })
      applySchoolTheme(newId)
      await useAuthStore.getState().refreshUser()
      toast.success(newId ? 'School theme updated' : 'School theme cleared')
    } catch (error: any) {
      setSchoolId(previous) // Revert
      toast.error(error.message || 'Failed to update school')
    } finally {
      setSchoolLoading(false)
    }
  }

  const handleAutoShareToggle = async (checked: boolean) => {
    if (!user) return
    
    setAutoShareLoading(true)
    try {
      const { error } = await supabase
        .from('users')
        .update({ auto_share_contact: checked })
        .eq('id', user.id)
      
      if (error) throw error
      
      setAutoShareContact(checked)
      await refreshUser()
      toast.success(checked 
        ? 'Auto-share enabled - your contact info is now visible to all classmates'
        : 'Auto-share disabled - classmates will need to request your contact info'
      )
    } catch (error: any) {
      toast.error(error.message || 'Failed to update setting')
      setAutoShareContact(!checked) // Revert
    } finally {
      setAutoShareLoading(false)
    }
  }
  
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    
    if (!user) return
    
    if (!formData.nickname) {
      toast.error('Nickname is required')
      return
    }
    
    setLoading(true)
    try {
        const { error } = await supabase
          .from('users')
          .update({
            nickname: formData.nickname,
            wechat: formData.wechat || null,
            qq: formData.qq || null,
            invite_code: formData.inviteCode || null,
          })
          .eq('id', user.id)
      
      if (error) throw error
      
      await refreshUser()
      toast.success('Profile updated')
    } catch (error: any) {
      toast.error(error.message || 'Update failed')
    } finally {
      setLoading(false)
    }
  }
  
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Profile</h1>
        <p className="text-muted-foreground">Manage your account settings</p>
      </div>
      
      {/* Avatar & Email */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <Avatar className="h-16 w-16">
              <AvatarImage src={user?.avatar_url} />
              <AvatarFallback className="text-xl">
                {user?.nickname?.charAt(0).toUpperCase() || 'U'}
              </AvatarFallback>
            </Avatar>
            <div className="space-y-1">
              <p className="font-semibold text-lg">{user?.nickname}</p>
              <p className="text-sm text-muted-foreground">{user?.email}</p>
              <div className="flex gap-2">
                {user?.is_edu_email ? (
                  <Badge variant="default" className="bg-green-600">
                    Verified Student
                  </Badge>
                ) : (
                  <Badge variant="secondary">Standard User</Badge>
                )}
                {user?.email_verified && (
                  <Badge variant="outline">Email Verified</Badge>
                )}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Privacy Settings */}
      <Card>
        <CardHeader>
          <CardTitle>Privacy Settings</CardTitle>
          <CardDescription>
            Control how your contact information is shared
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">Auto-share Contact Info</p>
              <p className="text-sm text-muted-foreground">
                When enabled, all classmates can see your WeChat/QQ without requesting
              </p>
            </div>
            <Switch
              checked={autoShareContact}
              onCheckedChange={handleAutoShareToggle}
              disabled={autoShareLoading}
            />
          </div>
          
          {autoShareContact && (
            <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
              Your contact info is visible to all classmates in your course rooms.
            </div>
          )}
          
          {!autoShareContact && (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
              You'll be asked about privacy each time you join a new course room.
            </div>
          )}
        </CardContent>
      </Card>
      
      {/* System UI (beta) */}
      <Card>
        <CardHeader>
          <CardTitle>System UI (beta)</CardTitle>
          <CardDescription>
            Gamified dashboard — daily quests, XP, streaks and school theming
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <p className="font-medium">Enable System UI</p>
              <p className="text-sm text-muted-foreground">
                Turns on the quest dashboard, XP pill and level-ups
              </p>
            </div>
            <Switch
              checked={systemUi}
              onCheckedChange={handleSystemUiToggle}
              disabled={systemUiLoading}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="school-theme">School theme</Label>
            <select
              id="school-theme"
              className="h-10 w-full rounded-md border border-[#E2E8F0] bg-white px-3 text-sm text-[#1F2937] focus:outline-none focus:ring-2 focus:ring-brand-600/20 focus:border-brand-600"
              value={schoolId}
              onChange={(e) => handleSchoolChange(e.target.value)}
              disabled={schoolLoading}
            >
              <option value="">No school theme</option>
              {SCHOOLS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Re-skins the System UI accent color with your school's signature hue.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Refer friends */}
      <Card>
        <CardHeader>
          <CardTitle>Refer Friends</CardTitle>
          <CardDescription>
            Invite 3 friends who join and import a schedule to unlock Seat Watch
            Unlimited for the semester
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">Your invite code</p>
              <p className="font-mono text-lg font-semibold tracking-widest">
                {referral?.code || '········'}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={handleCopyInviteLink}
              disabled={!referral?.code}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy link
            </Button>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">
              {Math.min(referral?.qualifiedCount ?? 0, referral?.required ?? 3)}/
              {referral?.required ?? 3} friends joined
            </p>
            <div className="flex gap-1.5">
              {Array.from({ length: referral?.required ?? 3 }).map((_, i) => (
                <div
                  key={i}
                  className={`h-2 flex-1 rounded-full ${
                    i < (referral?.qualifiedCount ?? 0) ? 'bg-teal-600' : 'bg-muted'
                  }`}
                />
              ))}
            </div>
          </div>

          {referral?.unlocked && (
            <Badge className="bg-teal-600 hover:bg-teal-600 text-white">
              Seat Watch Unlimited unlocked · this semester
            </Badge>
          )}
        </CardContent>
      </Card>

      {/* Edit Profile */}
      <Card>
        <CardHeader>
          <CardTitle>Edit Profile</CardTitle>
          <CardDescription>
            Your nickname and contact info are visible to connected classmates
          </CardDescription>
        </CardHeader>
        <CardContent>
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
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="wechat">WeChat ID</Label>
                <Input
                  id="wechat"
                  placeholder="For classmates to add you"
                  value={formData.wechat}
                  onChange={(e) => setFormData({ ...formData, wechat: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="qq">QQ Number</Label>
                <Input
                  id="qq"
                  placeholder="For classmates to add you"
                  value={formData.qq}
                  onChange={(e) => setFormData({ ...formData, qq: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteCode">Invite Code</Label>
              <Input
                id="inviteCode"
                placeholder="Enter invite code if you have one"
                value={formData.inviteCode}
                onChange={(e) => setFormData({ ...formData, inviteCode: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Non-edu accounts need an invite code to access AI parsing and matching.
              </p>
            </div>
            
            <Button type="submit" loading={loading}>
              Save Changes
            </Button>
          </form>
        </CardContent>
      </Card>
      
      {/* Connections List */}
      {user?.id && <ContactRequestsList userId={user.id} />}
      {user?.id && <ConnectionsList userId={user.id} />}
      
      {/* Quota Info */}
      <Card>
        <CardHeader>
          <CardTitle>Usage Quota</CardTitle>
          <CardDescription>
            {user?.is_edu_email 
              ? 'Student email users have unlimited free access' 
              : 'Standard users have limited free quota'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm">Schedule imports</span>
              <span className="font-medium">
                {user?.is_edu_email ? 'Unlimited' : '3 / 3'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm">Contact requests per day</span>
              <span className="font-medium">
                {user?.is_edu_email ? 'Unlimited' : '10 / 10'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
