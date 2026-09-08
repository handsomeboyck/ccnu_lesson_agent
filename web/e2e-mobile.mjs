// E2E：移动端（390x844）——底部导航 / 侧栏隐藏 / 头部⋯菜单 / 发消息
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'

async function login() {
  const u = 'mb-' + Math.random().toString(36).slice(2, 8)
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
  defaultViewport: { width: 390, height: 844 }, // iPhone 尺寸
})
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
  await new Promise((r) => setTimeout(r, 1200))

  const sidebarVisible = await page.evaluate(() => {
    const aside = document.querySelector('aside')
    return aside ? getComputedStyle(aside).display !== 'none' : false
  })
  const navText = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="移动端导航"]')
    return nav ? nav.textContent : ''
  })
  console.log('侧栏隐藏(mobile):', sidebarVisible ? '✗ 仍显示' : '✓ 已隐藏')
  console.log('底部导航(4 Tab):', ['对话', '资料库', '我的文件', '学习功能'].every((t) => navText.includes(t)) ? '✓' : `✗ ${navText}`)

  // 移动端占位符：短文案单行
  const ph = await page.evaluate(() => document.querySelector('textarea')?.placeholder ?? '')
  console.log('移动端占位符(短):', ph === '输入消息…' ? '✓' : `✗ ${ph}`)

  // 历史会话面板：新对话 + 历史列表
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '历史会话')
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 500))
  const panelText = await page.evaluate(() => document.body.innerText)
  console.log('历史会话面板打开:', panelText.includes('历史会话') && panelText.includes('新对话') ? '✓' : '✗')
  console.log('面板含空态或列表:', panelText.includes('暂无历史会话') || panelText.includes('今天') ? '✓' : '✗')
  // 关闭面板
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '关闭')
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 300))

  // 头部 ⋯ 菜单（新对话态：含模式选择 + 退出）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === '更多')
    b?.click()
  })
  await new Promise((r) => setTimeout(r, 400))
  const menuText = await page.evaluate(() => document.body.innerText)
  console.log('⋯ 菜单含模式/退出:', menuText.includes('模式') && menuText.includes('退出登录') ? '✓' : '✗')

  // 切到练习测评模式
  await page.evaluate(() => {
    const vis = [...document.querySelectorAll('button')].filter((x) => getComputedStyle(x).display !== 'none')
    const m = vis.find((b) => b.textContent.includes('练习测评'))
    m?.click()
  })
  await new Promise((r) => setTimeout(r, 400))
  const pill = await page.evaluate(() => {
    // 可见的模式胶囊（header 内第一个 rounded-full span；隐藏的桌面选择器不算）
    const spans = [...document.querySelectorAll('header span')].filter(
      (s) => getComputedStyle(s).display !== 'none',
    )
    return spans.map((s) => s.textContent).find((t) => /助教|练习|教师/.test(t ?? '')) ?? ''
  })
  console.log('移动端模式切换生效(胶囊变练习测评):', pill === '练习测评' ? '✓' : `✗（胶囊=${pill}）`)

  // 发一条消息（移动端完整链路）
  await page.evaluate(() => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '你好，介绍一下一元二次方程')
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
  const chatText = await page.evaluate(() => document.body.innerText)
  console.log('移动端发消息回复:', chatText.includes('一元二次方程') && !logs.length ? '✓' : '✗')

  // 底部导航跳转：我的文件
  await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')]
    const f = links.find((a) => a.textContent.includes('我的文件'))
    f?.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  const fileText = await page.evaluate(() => document.body.innerText)
  console.log('底部Tab跳转我的文件:', fileText.includes('我的文件') && page.url().includes('/artifacts') ? '✓' : '✗')

  // 底部 Tab 在各页面均可用 + 无横向溢出
  const tabBarPresent = () =>
    page.evaluate(() => {
      const nav = document.querySelector('nav[aria-label="移动端导航"]')
      return nav ? getComputedStyle(nav).display !== 'none' : false
    })
  const noHOverflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

  console.log('我的文件页 底部导航:', (await tabBarPresent()) ? '✓' : '✗', '| 无横向溢出:', (await noHOverflow()) ? '✓' : '✗')
  await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')]
    links.find((a) => a.textContent.includes('资料库'))?.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  console.log('资料库页 底部导航:', (await tabBarPresent()) ? '✓' : '✗', '| 无横向溢出:', (await noHOverflow()) ? '✓' : '✗')
  await page.evaluate(() => {
    const links = [...document.querySelectorAll('a')]
    links.find((a) => a.textContent.includes('学习功能'))?.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  console.log('学习功能页 底部导航:', (await tabBarPresent()) ? '✓' : '✗', '| 无横向溢出:', (await noHOverflow()) ? '✓' : '✗')

  console.log('控制台错误:', logs.join(' | ') || '(无)')
} finally {
  await browser.close()
}
