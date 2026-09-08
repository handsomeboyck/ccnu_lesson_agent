// 全量取证：#185 触发时抓 React 组件栈与控制台
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'
const DOCX = 'C:/Users/wps/software/work/dsh_workplace/agent/jiaoan.docx'

const u = 'stk-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const page = await browser.newPage()
  const all = []
  const pageErrors = []
  page.on('console', (m) => {
    const t = m.text()
    if (/185|Maximum|update depth|setState|useEffect|Warning|error/i.test(t)) all.push(`[${m.type()}] ${t.slice(0, 1200)}`)
  })
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.evaluateOnNewDocument(() => {
    window.__cap = []
    window.addEventListener('error', (e) => window.__cap.push('win-error: ' + e.message + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')))
    window.addEventListener('unhandledrejection', (e) => window.__cap.push('unhandledrejection: ' + String(e.reason).slice(0, 300)))
  })

  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1000))

  const input = await page.$('input[type=file]')
  await input.uploadFile(DOCX)
  await new Promise((r) => setTimeout(r, 2500))
  await page.evaluate(() => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '请用 /evaluate 评估这份教案，看看能得多少分')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 400))
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); b?.click() })

  // 等到错误横幅出现（最多 150s）
  await page.waitForFunction(() => document.body.innerText.includes('Maximum update depth'), { timeout: 180000 }).catch(() => console.log('(未等到 #185 横幅)'))
  await new Promise((r) => setTimeout(r, 1500))

  const capped = await page.evaluate(() => window.__cap ?? [])
  console.log('----页面级捕获----')
  console.log(capped.slice(0, 8).join('\n') || '(无)')
  console.log('----控制台相关日志----')
  console.log(all.slice(0, 12).join('\n---\n') || '(无)')
  console.log('----pageerror----')
  console.log(pageErrors.slice(0, 5).join('\n') || '(无)')
} finally {
  await browser.close()
}
