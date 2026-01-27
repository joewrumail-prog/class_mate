import { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import Layout from '@/components/Layout'
import HomePage from '@/pages/HomePage'
import LoginPage from '@/pages/LoginPage'
import ForgotPasswordPage from '@/pages/ForgotPasswordPage'
import RegisterPage from '@/pages/RegisterPage'
import ResetPasswordPage from '@/pages/ResetPasswordPage'
import CompleteProfilePage from '@/pages/CompleteProfilePage'
import DashboardPage from '@/pages/DashboardPage'
import ImportSchedulePage from '@/pages/ImportSchedulePage'
import RoomDetailPage from '@/pages/RoomDetailPage'
import ProfilePage from '@/pages/ProfilePage'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore()
  
  // 只在真正加载时显示 loading
  if (loading && !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto"></div>
          <p className="mt-2 text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }
  
  if (!user) {
    return <Navigate to="/login" replace />
  }
  
  return <>{children}</>
}

function RequireProfile({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore()

  if (user?.profile_complete === false) {
    return <Navigate to="/complete-profile" replace />
  }

  return <>{children}</>
}

function App() {
  const { refreshUser } = useAuthStore()

  useEffect(() => {
    refreshUser()
  }, [refreshUser])

  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/register" element={<RegisterPage />} />
      
      {/* Protected routes */}
      <Route path="/complete-profile" element={
        <PrivateRoute>
          <CompleteProfilePage />
        </PrivateRoute>
      } />
      <Route path="/dashboard" element={
        <PrivateRoute>
          <RequireProfile>
            <Layout>
              <DashboardPage />
            </Layout>
          </RequireProfile>
        </PrivateRoute>
      } />
      <Route path="/import" element={
        <PrivateRoute>
          <RequireProfile>
            <Layout>
              <ImportSchedulePage />
            </Layout>
          </RequireProfile>
        </PrivateRoute>
      } />
      <Route path="/room/:roomId" element={
        <PrivateRoute>
          <RequireProfile>
            <Layout>
              <RoomDetailPage />
            </Layout>
          </RequireProfile>
        </PrivateRoute>
      } />
      <Route path="/profile" element={
        <PrivateRoute>
          <RequireProfile>
            <Layout>
              <ProfilePage />
            </Layout>
          </RequireProfile>
        </PrivateRoute>
      } />
      
      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
