// 端到端：ask_user 触发 → 刷新/重开 → AskCard 应从历史持久化数据重建并渲染
import puppeteer from 'puppeteer-core'
const API = process.env.API || 'http://127.0.0.1:8080'
const SITE = API // 同一地址（vite dev 时用 SITE 覆盖）
const u = 'askh-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()

const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const p = await b.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1200))

  // 1) 触发 ask_user
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '出几道勾股定理练习题')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  // 等 ask 卡出现
  await p.waitForFunction(() => document.body.innerText.includes('提问正在向你提问') || document.body.innerText.includes('勾股定理'), { timeout: 60000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 2500))
  const live = await p.evaluate(() => {
    const hasAsk = document.body.innerText.includes('提问正在向你提问')
    const btns = [...document.querySelectorAll('button')].filter((x) => x.textContent.length >= 4 && x.textContent.length <= 20).map((x) => x.textContent.trim()).slice(0, 10)
    return { hasAsk, btns }
  })
  console.log('live ask 卡:', live.hasAsk ? '✓' : '✗', '| 按钮:', JSON.stringify(live.btns))

  // 2) 刷新页面（模拟重开）
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 4000))
  const hist = await p.evaluate(() => {
    const hasAsk = document.body.innerText.includes('提问正在向你提问')
    const hasQ = document.body.innerText.includes('勾股定理')
    const btns = [...document.querySelectorAll('button')].filter((x) => x.textContent.length >= 4 && x.textContent.length <= 20).map((x) => x.textContent.trim()).slice(0, 10)
    return { hasAsk, hasQ, btns, len: document.body.innerText.length }
  })
  console.log('刷新后 ask 卡:', hist.hasAsk ? '✓' : '✗', '| 提问文本:', hist.hasQ ? '✓' : '✗', '| 按钮:', JSON.stringify(hist.btns))
  console.log('控制台错误:', errs.length ? errs.slice(0, 2).join(' | ') : '(无)')
} finally {
  await b.close()
}
