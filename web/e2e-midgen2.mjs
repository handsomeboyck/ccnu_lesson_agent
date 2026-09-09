// 生成中刷新 + watchGeneration 日志
import puppeteer from 'puppeteer-core'
const API = 'http://127.0.0.1:8080'
const SITE = 'http://localhost:5173'
const u = 'rs6-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const p = await b.newPage()
  const logs = []
  p.on('console', (m) => { const t = m.text(); if (t.includes('[watchGen]')) logs.push(t) })
  p.on('pageerror', (e) => logs.push('PAGEERR: ' + e.message))
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1200))
  // 发长任务
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请写一篇1000字关于学习方法的长文章')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await new Promise((r) => setTimeout(r, 2000))
  logs.length = 0
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 35000))
  console.log('watchGen 日志:')
  console.log(logs.slice(0, 8).join('\n') || '(无)')
  const st = await p.evaluate(() => {
    const t = document.body.innerText
    return { len: t.length, hasArticle: t.includes('学习方法') && t.length > 400, map: localStorage.getItem('ccnu-stream-map') }
  })
  console.log('回复:', st.hasArticle ? '✓ (' + st.len + '字)' : '✗ (' + st.len + ')', '| map:', st.map)
} finally {
  await b.close()
}
