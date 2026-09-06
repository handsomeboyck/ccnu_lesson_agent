import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { login, register } from '../api/client'
import { useAuth } from '../store/auth'

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
    <div className="auth-page">
      <div className="auth-card">
        <div className="ccnu-emblem">华</div>
        <h1>
          <span className="ccnu-wordmark">华中师范大学 · 智能学伴</span>
        </h1>
        <p className="auth-sub">创建账号，开始与教育版 AI 学伴互动</p>
        <form onSubmit={onSubmit} className="auth-form">
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              minLength={3}
              placeholder="至少 3 个字符"
            />
          </label>
          <label>
            昵称（可选）
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="如何称呼你"
            />
          </label>
          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              required
              minLength={8}
              placeholder="至少 8 位"
            />
          </label>
          <label>
            确认密码
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
              placeholder="再次输入密码"
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? '注册中…' : '注 册'}
          </button>
        </form>
        <p className="auth-alt">
          已有账号？<Link to="/login">直接登录</Link>
        </p>
      </div>
    </div>
  )
}
