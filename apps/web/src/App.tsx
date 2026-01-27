import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/stores/auth'
import Layout from '@/components/Layout'
import HomePage from '@/pages/HomePage'
import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import DashboardPage from '@/pages/DashboardPage'
import ImportSchedulePage from '@/pages/ImportSchedulePage'
import RoomDetailPage from '@/pages/RoomDetailPage'
import ProfilePage from '@/pages/ProfilePage'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore()
  
  // 只在真正加载时显示 loading
  if (loading) {
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

function App() {
  return (
    <Routes>
      {/* Public routes */}
      <Route path="/" element={<HomePage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      
      {/* Protected routes */}
      <Route path="/dashboard" element={
        <PrivateRoute>
          <Layout>
            <DashboardPage />
          </Layout>
        </PrivateRoute>
      } />
      <Route path="/import" element={
        <PrivateRoute>
          <Layout>
            <ImportSchedulePage />
          </Layout>
        </PrivateRoute>
      } />
      <Route path="/room/:roomId" element={
        <PrivateRoute>
          <Layout>
            <RoomDetailPage />
          </Layout>
        </PrivateRoute>
      } />
      <Route path="/profile" element={
        <PrivateRoute>
          <Layout>
            <ProfilePage />
          </Layout>
        </PrivateRoute>
      } />
      
      {/* Fallback */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
