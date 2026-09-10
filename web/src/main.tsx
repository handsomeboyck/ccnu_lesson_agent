import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'

// 全局错误自动上报：捕获 JS 异常 / Promise 拒绝 → GET /v1/debug/log?msg=...
// （后端 logMiddleware 会记录所有请求路径，含 msg 参数；404 无副作用，keepalive 保证卸载前发出）
function report(prefix: string, detail: string) {
  try {
    const msg = encodeURIComponent(`${prefix}:${detail}`.slice(0, 2000))
    fetch(`/v1/debug/log?msg=${msg}`, { keepalive: true, method: 'GET' }).catch(() => {})
  } catch {
    // 忽略上报失败
  }
}
window.addEventListener('error', (e) => {
  report('js', `${e.message || ''} @ ${e.filename || ''}:${e.lineno || ''}:${e.colno || ''}`)
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { message?: string } | undefined
  report('promise', r?.message ? String(r.message) : String(e.reason ?? 'unknown'))
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
