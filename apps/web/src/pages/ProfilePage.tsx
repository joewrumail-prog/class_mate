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

export default function ProfilePage() {
  const { user, refreshUser } = useAuthStore()
  
  const [loading, setLoading] = useState(false)
  const [autoShareLoading, setAutoShareLoading] = useState(false)
  const [autoShareContact, setAutoShareContact] = useState(user?.auto_share_contact ?? false)
  const [formData, setFormData] = useState({
    nickname: user?.nickname || '',
    wechat: user?.wechat || '',
    qq: user?.qq || '',
  })

  // Sync auto_share_contact when user changes
  useEffect(() => {
    setAutoShareContact(user?.auto_share_contact ?? false)
  }, [user?.auto_share_contact])

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
