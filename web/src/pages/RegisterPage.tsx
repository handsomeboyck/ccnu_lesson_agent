import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { login, register } from '../api/client'
import { useAuth } from '../store/auth'
import PasswordField from '../components/PasswordField'
import AuthLayout from '../components/AuthLayout'
import { Button } from '../components/ui/button'

export default function RegisterPage() {
  const navigate = useNavigate()
  const setAuth = useAuth((s) => s.setAuth)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    if (password.length < 8) {
      setError('密码至少 8 位')
      return
    }
    setBusy(true)
    try {
      await register({ username: username.trim(), password, display_name: displayName.trim() })
      // 注册成功后自动登录
      const pair = await login(username.trim(), password)
      setAuth(pair)
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败')
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
          <div className="font-display text-sm font-bold">华中师范大学 · 智能学伴</div>
          <div className="text-[11px] text-muted-foreground">教育版 AI 学伴</div>
        </div>
      </div>
      <h1 className="font-display text-xl font-bold">创建账号</h1>
      <p className="mt-1 text-sm text-muted-foreground">加入教育版智能学伴</p>
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
            placeholder="至少 3 个字符"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-2 block text-[13px] font-normal text-muted-foreground">昵称（可选）</span>
          <input
            className="input-base"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="如何称呼你"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-2 block font-medium">密码</span>
          <PasswordField
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
            placeholder="至少 8 位"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-2 block font-medium">确认密码</span>
          <PasswordField
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            required
            placeholder="再次输入密码"
          />
        </label>
        {error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
        <Button type="submit" className="w-full tracking-[0.3em]" size="lg" disabled={busy}>
          {busy ? '注册中…' : '注册'}
        </Button>
      </form>
      <p className="mt-5 text-center text-sm text-muted-foreground">
        已有账号？{' '}
        <Link to="/login" className="font-medium text-ccnu-blue hover:underline">
          直接登录
        </Link>
      </p>
    </AuthLayout>
  )
}
