// 真实用户流程：触发 ask → 新对话切走 → 点侧栏切回 → 检查 AskCard 渲染
import puppeteer from 'puppeteer-core'
const API = process.env.API || 'http://127.0.0.1:8080'
const SITE = process.env.SITE || API
const u = 'rs3-' + Math.random().toString(36).slice(2, 8)
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

  // 1) 触发 ask
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '出几道勾股定理练习题')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await p.waitForFunction(() => document.body.innerText.includes('提问正在向你提问'), { timeout: 60000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))
  const liveOpts = await p.evaluate(() => [...document.querySelectorAll('button')].filter((x) => x.textContent.trim().length >= 4 && x.textContent.trim().length <= 25).map((x) => x.textContent.trim()).filter((t) => t.includes('道') || t.includes('热身')).length)
  console.log('live ask 选项数:', liveOpts, liveOpts >= 2 ? '✓' : '✗')

  // 2) 新对话切走
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新对话')); btn?.click() })
  await new Promise((r) => setTimeout(r, 1500))

  // 3) 点侧栏 div 切回（会话标题含 勾股定理）
  const clicked = await p.evaluate(() => {
    const items = [...document.querySelectorAll('aside div')]
    const target = items.find((x) => x.textContent.includes('勾股定理') && x.className.includes('cursor-pointer'))
    if (!target) return false
    target.click()
    return true
  })
  console.log('切回点击:', clicked ? '✓' : '✗ (侧栏没找到会话)')
  await new Promise((r) => setTimeout(r, 3500))

  // 4) 检查主区 AskCard
  const st = await p.evaluate(() => {
    const main = document.querySelector('main')
    const t = main?.innerText || ''
    const askBtns = [...(main?.querySelectorAll('button') ?? [])].filter((x) => x.textContent.trim().length >= 4 && x.textContent.trim().length <= 25 && (x.textContent.includes('道') || x.textContent.includes('热身'))).map((x) => x.textContent.trim())
    return { askCards: (t.match(/提问正在向你提问/g) || []).length, askBtns, snippet: t.slice(0, 200).replace(/\n/g, ' | ') }
  })
  console.log('切回后 ask 卡:', st.askCards, st.askCards === 1 ? '✓' : '✗', '| 选项:', JSON.stringify(st.askBtns))
  console.log('主区开头:', st.snippet)
  console.log('控制台错误:', errs.length ? errs.slice(0, 2).join(' | ') : '(无)')
} finally {
  await b.close()
}
