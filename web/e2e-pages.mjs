// 多页面冒烟：登录/注册渲染、资料库/产物/技能页、监控权限守卫。
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'

async function login() {
  const u = 'page-e2e-' + Math.random().toString(36).slice(2, 8)
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
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1440, height: 900 }, // 桌面视口
})
try {
  const page = await browser.newPage()
  const logs = []
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(`[console.error] ${m.text()}`)
  })

  // 0. 首页（匿名访问 / → 展示能力 + 注册/登录 CTA）
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 800))
  let homeText = await page.evaluate(() => document.body.innerText)
  console.log(
    '首页(匿名):',
    homeText.includes('华中师范大学 · 智能助教') && homeText.includes('它能做什么') && homeText.includes('注册使用') && homeText.includes('登录') ? '✓' : '✗',
  )

  // 1. 登录页
  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 800))
  let text = await page.evaluate(() => document.body.innerText)
  console.log('登录页:', text.includes('欢迎回来') && text.includes('登录') && !text.includes('登 录') ? '✓' : '✗')

  // 2. 注册页
  await page.goto('http://localhost:5173/register', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 800))
  text = await page.evaluate(() => document.body.innerText)
  console.log('注册页:', text.includes('创建账号') && text.includes('注册') && !text.includes('注 册') ? '✓' : '✗')

  // 3. 注入登录态 → 资料库 / 产物 / 技能 / 监控守卫
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem(
        'ccnu-auth',
        JSON.stringify({ state: { user: u, accessToken: t, refreshToken: 'x' }, version: 0 }),
      )
    },
    { t: token, u: user },
  )

  await page.goto('http://localhost:5173/library', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('h1', { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 1000))
  text = await page.evaluate(() => document.body.innerText)
  console.log('资料库页:', text.includes('我的资料库') ? '✓' : '✗')

  await page.goto('http://localhost:5173/artifacts', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1000))
  text = await page.evaluate(() => document.body.innerText)
  console.log('我的文件页:', text.includes('我的文件') ? '✓' : '✗')

  await page.goto('http://localhost:5173/skills', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1200))
  text = await page.evaluate(() => document.body.innerText)
  console.log('学习功能页:', text.includes('学习功能') && (text.includes('自定义') || text.includes('内置') || text.includes('加载中')) ? '✓' : '✗')

  await page.goto('http://localhost:5173/monitor', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1200))
  text = await page.evaluate(() => document.body.innerText)
  console.log('监控守卫(student→重定向):', !text.includes('监控中心') && (text.includes('新对话') || text.includes('智能助教')) ? '✓' : '✗')

  // 4. 聊天页回归（新对话入口可用）
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 15000 })
  console.log('聊天页:', '✓')

  console.log('== 控制台错误 ==')
  console.log(logs.join('\n') || '(无)')
} finally {
  await browser.close()
}
