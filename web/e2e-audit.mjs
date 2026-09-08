// UI 审查截图：捕获各页面关键状态（1440x900）
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SITE = process.env.SITE ?? 'http://127.0.0.1:8080'
const API = process.env.API ?? 'http://127.0.0.1:8080'
const OUT = process.env.OUT ?? 'ui-shots'
fs.mkdirSync(OUT, { recursive: true })

async function login() {
  const u = 'ui-' + Math.random().toString(36).slice(2, 8)
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
  defaultViewport: { width: 1440, height: 900 },
})
try {
  const page = await browser.newPage()
  const logs = []
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` })

  // 1. 登录 / 注册
  await page.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1200))
  await shot('01-login')
  await page.goto(`${SITE}/register`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1200))
  await shot('02-register')

  // 注入登录态
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem(
        'ccnu-auth',
        JSON.stringify({ state: { user: u, accessToken: t, refreshToken: 'x' }, version: 0 }),
      )
    },
    { t: token, u: user },
  )

  // 2. 聊天：欢迎态
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1200))
  await shot('03-chat-welcome')

  const setText = (v) =>
    page.evaluate((val) => {
      const el = document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, val)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, v)
  const send = () =>
    page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送')
      b?.click()
    })
  const waitEnd = (t = 150000) =>
    page.waitForFunction(
      () => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')),
      { timeout: t },
    )

  // 3. 聊天：流式思考中（发送后 1.5s 截）
  await setText('请详细讲解什么是导数，结合图像，尽量详细')
  await new Promise((r) => setTimeout(r, 300))
  await send()
  await new Promise((r) => setTimeout(r, 1500))
  await shot('04-chat-thinking')
  await waitEnd()
  await new Promise((r) => setTimeout(r, 800))
  await shot('05-chat-answer')

  // 4. 聊天：ask 流程（工具卡 + 提问卡）
  await setText('帮我出几道题吧')
  await new Promise((r) => setTimeout(r, 300))
  await send()
  await waitEnd()
  await new Promise((r) => setTimeout(r, 800))
  await shot('06-chat-ask')

  // 5. 资料库空态 + 上传一个文件
  await page.goto(`${SITE}/library`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1500))
  await shot('07-library-empty')
  fs.writeFileSync(`${OUT}/sample.txt`, '三角函数基本概念：正弦 sin、余弦 cos、正切 tan，周期 2π。\n示例公式：sin²θ + cos²θ = 1。', 'utf8')
  const fi = await page.$('input[type="file"]')
  await fi.uploadFile(`${OUT}/sample.txt`)
  await new Promise((r) => setTimeout(r, 4000))
  await shot('08-library-file')

  // 6. 产物库空态
  await page.goto(`${SITE}/artifacts`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 1500))
  await shot('09-artifacts-empty')

  // 7. 技能页
  await page.goto(`${SITE}/skills`, { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 2000))
  await shot('10-skills')

  console.log('截图完成:', fs.readdirSync(OUT).join(', '))
  console.log('页面错误:', logs.join(' | ') || '(无)')
} finally {
  await browser.close()
}
