import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { supabase } from '@/lib/supabase'

export interface User {
  id: string
  email: string
  nickname: string
  avatar_url?: string
  wechat?: string
  qq?: string
  school?: string
  is_edu_email: boolean
  email_verified: boolean
  auto_share_contact?: boolean
  created_at: string
  profile_complete?: boolean
}

interface AuthState {
  user: User | null
  loading: boolean
  setUser: (user: User | null) => void
  setLoading: (loading: boolean) => void
  logout: () => Promise<void>
  refreshUser: () => Promise<void>
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      loading: true,
      
      setUser: (user) => set({ user, loading: false }),
      
      setLoading: (loading) => set({ loading }),
      
      logout: async () => {
        await supabase.auth.signOut()
        set({ user: null, loading: false })
      },
      
      refreshUser: async () => {
        try {
          if (get().loading) return
          set({ loading: true })
          
          const { data: { session } } = await supabase.auth.getSession()
          
          if (!session?.user) {
            set({ user: null, loading: false })
            return
          }
          
          // Fetch user profile from our users table
          const { data: profile, error } = await supabase
            .from('users')
            .select('*')
            .eq('id', session.user.id)
            .single()
          
          if (error && error.code !== 'PGRST116') {
            console.error('Profile fetch error:', error)
          }
          
          if (profile) {
            const isComplete = Boolean(profile.nickname && profile.school)
            set({ user: { ...(profile as User), profile_complete: isComplete }, loading: false })
          } else {
            // User exists in auth but not in users table yet
            const fallbackNickname = session.user.email?.split('@')[0] || 'User'
            const isEdu = session.user.email?.includes('.edu') || false

            const { data: createdProfile, error: createError } = await supabase
              .from('users')
              .insert({
                id: session.user.id,
                email: session.user.email || '',
                nickname: fallbackNickname,
                is_edu_email: isEdu,
                email_verified: !!session.user.email_confirmed_at,
              })
              .select('*')
              .single()

            if (!createError && createdProfile) {
              set({ user: { ...(createdProfile as User), profile_complete: false }, loading: false })
            } else {
              // Create a basic user object so they can complete registration
              set({
                user: {
                  id: session.user.id,
                  email: session.user.email || '',
                  nickname: fallbackNickname,
                  is_edu_email: isEdu,
                  email_verified: !!session.user.email_confirmed_at,
                  created_at: session.user.created_at,
                  profile_complete: false,
                } as User,
                loading: false,
              })
            }
          }
        } catch (error: any) {
          if (error?.name === 'AbortError') {
            set({ loading: false })
            return
          }
          console.error('Error refreshing user:', error)
          set({ user: null, loading: false })
        }
      },
    }),
    {
      name: 'classmate-auth',
      partialize: (state) => ({ user: state.user }),
      onRehydrateStorage: () => (state) => {
        // 恢复后检查 session
        if (state) {
          state.refreshUser()
        }
      },
    }
  )
)

// 监听认证状态变化
supabase.auth.onAuthStateChange(async (event, session) => {
  console.log('Auth event:', event)
  
  if (event === 'SIGNED_IN' && session?.user) {
    await useAuthStore.getState().refreshUser()
  } else if (event === 'SIGNED_OUT') {
    useAuthStore.getState().setUser(null)
  } else if (event === 'TOKEN_REFRESHED' && session?.user) {
    await useAuthStore.getState().refreshUser()
  }
})
