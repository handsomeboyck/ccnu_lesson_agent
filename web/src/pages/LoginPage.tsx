import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { login } from '../api/client'
import { useAuth } from '../store/auth'
import PasswordField from '../components/PasswordField'

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
    <div className="auth-page">
      <aside className="auth-panel">
        <div>
          <div className="ccnu-emblem">华</div>
          <div className="auth-panel-title">华中师范大学 · 智能学伴</div>
          <div className="auth-panel-slogan">求实创新 · 立德树人</div>
          <p className="auth-panel-desc">
            面向师生的教育版 AI 学伴：多轮问答 · 生成教案与试卷 ·
            文档分析与图表产出。以师范精神赋能教与学。
          </p>
        </div>
        <div className="auth-panel-foot">Central China Normal University · CCNU AI</div>
      </aside>
      <div className="auth-card">
        <div className="ccnu-emblem">华</div>
        <h1>
          <span className="ccnu-wordmark">欢迎回来</span>
        </h1>
        <p className="auth-sub">登录教育版智能学伴</p>
        <form onSubmit={onSubmit} className="auth-form">
          <label>
            用户名
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              required
              minLength={3}
              placeholder="请输入用户名"
            />
          </label>
          <label>
            密码
            <PasswordField
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
              placeholder="请输入密码"
            />
          </label>
          {error && <div className="auth-error">{error}</div>}
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? '登录中…' : '登 录'}
          </button>
        </form>
        <p className="auth-alt">
          还没有账号？<Link to="/register">立即注册</Link>
        </p>
      </div>
    </div>
  )
}
