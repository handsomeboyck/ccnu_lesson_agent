import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { me } from './api/client'
import { useAuth } from './store/auth'
import HomePage from './pages/HomePage'
import ChatPage from './pages/ChatPage'
import LoginPage from './pages/LoginPage'
import RegisterPage from './pages/RegisterPage'
import SkillsPage from './pages/SkillsPage'
import LibraryPage from './pages/LibraryPage'
import ArtifactsPage from './pages/ArtifactsPage'
import MonitorPage from './pages/MonitorPage'
import SpikePage from './pages/SpikePage'

/** 已登录但用户信息缺失时先拉取 /me 恢复会话。 */
function AuthBootstrap({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user)
  const accessToken = useAuth((s) => s.accessToken)
  const setUser = useAuth((s) => s.setUser)
  const [checking, setChecking] = useState(Boolean(accessToken && !user))

  useEffect(() => {
    if (!accessToken || user) return
    let alive = true
    me()
      .then((u) => alive && setUser(u))
      .catch(() => alive && useAuth.getState().clear())
      .finally(() => alive && setChecking(false))
    return () => {
      alive = false
    }
  }, [accessToken, user, setUser])

  if (checking) {
    return (
      <div className="boot-screen">
        <div className="boot-spinner" />
        <p>正在恢复会话…</p>
      </div>
    )
  }
  return children
}

function RequireAuth({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  return children
}

function RequireRole({ role, children }: { role: string; children: ReactNode }) {
  const user = useAuth((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role !== role) return <Navigate to="/chat" replace />
  return children
}

/** 教职工（教师/管理员）可见；学生隐藏（如学习功能管理面）。 */
function RequireStaff({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user)
  if (!user) return <Navigate to="/login" replace />
  if (user.role === 'student') return <Navigate to="/chat" replace />
  return children
}

function GuestOnly({ children }: { children: ReactNode }) {
  const user = useAuth((s) => s.user)
  if (user) return <Navigate to="/chat" replace />
  return children
}

export default function App() {
  return (
    <AuthBootstrap>
      <Routes>
        <Route
          path="/login"
          element={
            <GuestOnly>
              <LoginPage />
            </GuestOnly>
          }
        />
        <Route
          path="/register"
          element={
            <GuestOnly>
              <RegisterPage />
            </GuestOnly>
          }
        />
        <Route
          path="/"
          element={<HomePage />}
        />
        <Route
          path="/chat"
          element={
            <RequireAuth>
              <ChatPage />
            </RequireAuth>
          }
        />
        <Route
          path="/skills"
          element={
            <RequireStaff>
              <SkillsPage />
            </RequireStaff>
          }
        />
        <Route
          path="/library"
          element={
            <RequireAuth>
              <LibraryPage />
            </RequireAuth>
          }
        />
        <Route
          path="/artifacts"
          element={
            <RequireAuth>
              <ArtifactsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/monitor"
          element={
            <RequireRole role="admin">
              <MonitorPage />
            </RequireRole>
          }
        />
        <Route path="/spike" element={<SpikePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthBootstrap>
  )
}
