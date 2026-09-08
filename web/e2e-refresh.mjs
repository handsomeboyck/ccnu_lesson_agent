// E2E：刷新页面后自动恢复会话 + 登录态保留
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'

async function login() {
  const u = 're-' + Math.random().toString(36).slice(2, 8)
  await fetch(`${API}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
  }).catch(() => {})
  const r = await fetch(`${API}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
  })
  return r.json()
}

const { user, access_token: token } = await login()
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
try {
  const page = await browser.newPage()
  const logs = []
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem(
        'ccnu-auth',
        JSON.stringify({ state: { user: u, accessToken: t, refreshToken: 'x' }, version: 0 }),
      )
    },
    { t: token, u: user },
  )
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1000))

  // 发一条消息
  await page.evaluate(() => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '请介绍一下一元二次方程的求根公式')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送')
    b?.click()
  })
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')),
    { timeout: 150000 },
  )
  await new Promise((r) => setTimeout(r, 800))
  const before = await page.evaluate(() => document.body.innerText)

  // 刷新页面
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 2500))
  const after = await page.evaluate(() => document.body.innerText)

  console.log('刷新后仍登录(未跳登录页):', !page.url().includes('/login') && after.includes('新对话') ? '✓' : '✗')
  console.log('会话自动恢复(历史文本):', after.includes('求根公式') || after.includes('一元二次方程') ? '✓' : '✗')
  console.log('回答内容恢复:', after.includes('判别式') || after.includes('公式') ? '✓' : '✗')
  console.log('未回到欢迎空态:', !after.includes('发送一条消息开始') || before === after ? '✓(有内容)' : '✗(空了)')
  console.log('控制台错误:', logs.join(' | ') || '(无)')
} finally {
  await browser.close()
}
