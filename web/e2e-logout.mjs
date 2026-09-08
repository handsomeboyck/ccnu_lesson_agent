// E2E：点击退出登录 → 跳转登录页 + 未登录态
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'

async function login() {
  const u = 'lo-' + Math.random().toString(36).slice(2, 8)
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
  console.log('登录态进入聊天页: ✓')

  // 点击侧栏底部退出按钮
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.title === '退出登录')
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 2500))

  const url = page.url()
  const text = await page.evaluate(() => document.body.innerText)
  console.log('跳转到登录页:', url.includes('/login') ? '✓' : `✗（当前 ${url}）`)
  console.log('显示未登录态(欢迎回来):', text.includes('欢迎回来') ? '✓' : '✗')
  console.log('未回弹到聊天页:', !text.includes('新对话') ? '✓' : '✗')
} finally {
  await browser.close()
}
