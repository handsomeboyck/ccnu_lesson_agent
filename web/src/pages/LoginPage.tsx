import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { login } from '../api/client'
import { useAuth } from '../store/auth'
import PasswordField from '../components/PasswordField'
import AuthLayout from '../components/AuthLayout'
import { Button } from '../components/ui/button'

export default function LoginPage() {
  const navigate = useNavigate()
  const setAuth = useAuth((s) => s.setAuth)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const pair = await login(username.trim(), password)
      setAuth(pair)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout>
      <div className="mb-8 flex items-center gap-3 lg:hidden">
        <div className="flex size-10 items-center justify-center rounded-full bg-ccnu-blue font-display text-lg font-bold text-white">
          华
        </div>
        <div>
          <div className="font-display text-sm font-bold">华中师范大学 · 智能助教</div>
          <div className="text-[11px] text-muted-foreground">AI 智能助教</div>
        </div>
      </div>
      <h1 className="font-display text-xl font-bold">欢迎回来</h1>
      <p className="mt-1 text-sm text-muted-foreground">登录智能助教</p>
      <form onSubmit={onSubmit} className="mt-6 space-y-4">
        <label className="block text-sm">
          <span className="mb-2 block font-medium">用户名</span>
          <input
            className="input-base"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            minLength={3}
            placeholder="请输入用户名"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-2 block font-medium">密码</span>
          <PasswordField
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
            placeholder="请输入密码"
          />
        </label>
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <Button type="submit" className="w-full tracking-[0.3em]" size="lg" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        还没有账号？{' '}
        <Link to="/register" className="font-medium text-ccnu-blue hover:underline">
          立即注册
        </Link>
      </p>
    </AuthLayout>
  )
}
