import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase'
import { useAuthStore } from '@/stores/auth'
import { isEduEmail } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Calendar, Mail, Info, GraduationCap } from 'lucide-react'
import { toast } from 'sonner'

export default function RegisterPage() {
  const navigate = useNavigate()
  const { refreshUser } = useAuthStore()
  
  const [loading, setLoading] = useState(false)
  const [step, setStep] = useState<'email' | 'verify' | 'profile'>('email')
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    nickname: '',
    wechat: '',
    qq: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  
  const isEdu = isEduEmail(formData.email)
  const isRutgersEmail = formData.email.toLowerCase().includes('@rutgers.edu')
  
  const validateEmail = () => {
    const newErrors: Record<string, string> = {}
    
    if (!formData.email) {
      newErrors.email = 'Email is required'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
      newErrors.email = 'Please enter a valid email address'
    }
    
    if (!formData.password) {
      newErrors.password = 'Password is required'
    } else if (formData.password.length < 6) {
      newErrors.password = 'Password must be at least 6 characters'
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }
  
  const validateProfile = () => {
    const newErrors: Record<string, string> = {}
    
    if (!formData.nickname) {
      newErrors.nickname = 'Nickname is required'
    } else if (formData.nickname.length < 2) {
      newErrors.nickname = 'Nickname must be at least 2 characters'
    }
    
    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }
  
  const pendingProfileKey = 'classmate-pending-profile'

  const saveProfile = async (
    userId: string,
    email: string,
    profile: { nickname: string; wechat?: string; qq?: string; isEdu: boolean; emailVerified: boolean }
  ) => {
    const { error } = await supabase
      .from('users')
      .upsert({
        id: userId,
        email,
        nickname: profile.nickname,
        wechat: profile.wechat || null,
        qq: profile.qq || null,
        school: 'Rutgers University - New Brunswick',
        is_edu_email: profile.isEdu,
        email_verified: profile.emailVerified,
        auto_share_contact: false,
      })

    if (error) throw error
  }

  useEffect(() => {
    const checkPendingProfile = async () => {
      const { data: { session } } = await supabase.auth.getSession()
      const pendingRaw = localStorage.getItem(pendingProfileKey)
      if (!session?.user || !pendingRaw) return

      try {
        const pending = JSON.parse(pendingRaw) as {
          nickname: string
          wechat?: string
          qq?: string
          email?: string
          isEdu: boolean
        }

        if (!pending.nickname) return

        await saveProfile(session.user.id, session.user.email || pending.email || '', {
          ...pending,
          emailVerified: !!session.user.email_confirmed_at,
        })
        localStorage.removeItem(pendingProfileKey)
        await refreshUser()
        toast.success('Registration complete!')
        navigate('/dashboard')
      } catch (error: any) {
        console.error('Failed to save pending profile:', error)
      }
    }

    checkPendingProfile()
  }, [navigate, refreshUser])

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateEmail()) return
    
    setLoading(true)
    try {
      const { data, error } = await supabase.auth.signUp({
        email: formData.email,
        password: formData.password,
        options: {
          emailRedirectTo: `${window.location.origin}/complete-profile`,
        },
      })
      
      if (error) throw error
      
      console.log('SignUp response:', data)
      toast.success('Verification email sent! Please check your inbox.')
      if (data.session) {
        setStep('profile')
      } else {
        localStorage.setItem(pendingProfileKey, JSON.stringify({ email: formData.email, isEdu }))
        setStep('verify')
      }
    } catch (error: any) {
      console.error('Register error:', error)
      if (error.message?.includes('aborted') || error.name === 'AbortError') {
        toast.error('Network timeout. Please check your connection.')
      } else {
        toast.error(error.message || 'Registration failed')
      }
    } finally {
      setLoading(false)
    }
  }
  
  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validateProfile()) return
    
    setLoading(true)
    try {
      // Get current user session
      const { data: { session } } = await supabase.auth.getSession()

      if (!session?.user) {
        // Save profile locally and prompt verification
        localStorage.setItem(pendingProfileKey, JSON.stringify({
          nickname: formData.nickname,
          wechat: formData.wechat,
          qq: formData.qq,
          email: formData.email,
          isEdu,
        }))
        toast.info('Please verify your email first. We will save your profile once you return.')
        navigate('/login')
        return
      }

      await saveProfile(session.user.id, session.user.email || formData.email, {
        nickname: formData.nickname,
        wechat: formData.wechat,
        qq: formData.qq,
        isEdu,
        emailVerified: !!session.user.email_confirmed_at,
      })
      
      await refreshUser()
      toast.success('Registration complete!')
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
          <CardTitle>Create Account</CardTitle>
          <CardDescription>
            {step === 'email' ? 'Enter your email to get started' : step === 'verify' ? 'Verify your email' : 'Complete your profile'}
          </CardDescription>
        </CardHeader>
        
        <CardContent>
          {/* School info banner */}
          <div className="mb-4 p-3 bg-primary/10 rounded-lg flex items-center gap-2 text-sm">
            <GraduationCap className="h-5 w-5 text-primary flex-shrink-0" />
            <span>
              ClassMate is currently available for <strong>Rutgers University - New Brunswick</strong> students only.
            </span>
          </div>

          {step === 'email' ? (
            <form onSubmit={handleEmailSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="your@rutgers.edu"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  error={errors.email}
                />
                {formData.email && (
                  <p className={`text-xs flex items-center gap-1 ${isRutgersEmail ? 'text-green-600' : 'text-amber-600'}`}>
                    <Info className="h-3 w-3" />
                    {isRutgersEmail 
                      ? 'Rutgers email detected - unlimited free access!' 
                      : 'We recommend using your @rutgers.edu email for full access'}
                  </p>
                )}
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="At least 6 characters"
                  value={formData.password}
                  onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  error={errors.password}
                />
              </div>
              
              <Button type="submit" className="w-full" loading={loading}>
                <Mail className="mr-2 h-4 w-4" />
                Send Verification Email
              </Button>
            </form>
          ) : step === 'verify' ? (
            <div className="space-y-4">
              <div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground">
                We sent a verification link to <strong>{formData.email || 'your email'}</strong>. Please click it to activate your account.
              </div>
              <Button className="w-full" onClick={() => navigate('/login')}>
                I have verified, go to Login
              </Button>
            </div>
          ) : (
            <form onSubmit={handleProfileSubmit} className="space-y-4">
              <div className="p-3 rounded-lg bg-muted/50 text-sm text-muted-foreground mb-4">
                Please check your email and click the verification link. You can complete your profile while waiting.
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="nickname">Nickname *</Label>
                <Input
                  id="nickname"
                  placeholder="Your display name"
                  value={formData.nickname}
                  onChange={(e) => setFormData({ ...formData, nickname: e.target.value })}
                  error={errors.nickname}
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
                Complete Registration
              </Button>
            </form>
          )}
          
          <div className="mt-6 text-center text-sm">
            Already have an account?{' '}
            <Link to="/login" className="text-primary hover:underline">
              Login
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
