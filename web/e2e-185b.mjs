// E2E：evaluate_design + docx 附件 → 复现 React #185（dev 模式拿完整错误栈）
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'
const DOCX = 'C:/Users/wps/software/work/dsh_workplace/agent/jiaoan.docx'

async function login() {
  const u = 'r185-' + Math.random().toString(36).slice(2, 8)
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
  const errors = []
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text().slice(0, 300)}`)
  })

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

  // 上传 docx（走真实 UI 文件输入）
  const input = await page.$('input[type=file]')
  await input.uploadFile(DOCX)
  await new Promise((r) => setTimeout(r, 2500))
  const chip = await page.evaluate(() => document.body.innerText.includes('jiaoan.docx'))
  console.log('附件上传(UI chip):', chip ? '✓' : '✗')

  // 输入并发送：触发 evaluate_design
  await page.evaluate(() => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '请用 /evaluate 评估这份教案，看看能得多少分')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 400))
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送')
    b?.click()
  })

  // 等流结束（发送按钮恢复 / 停止按钮消失）
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')),
    { timeout: 180000 },
  ).catch(() => console.log('(等待超时，继续收集)'))
  await new Promise((r) => setTimeout(r, 1500))

  const body = await page.evaluate(() => document.body.innerText)
  console.log('----结果----')
  console.log('#185 出现:', errors.some((e) => e.includes('185') || e.includes('Maximum update depth')) ? '⚠️ 是' : '✓ 否')
  const errs = errors.filter((e) => e.includes('185') || e.includes('Maximum') || e.includes('update depth'))
  for (const e of errs.slice(0, 4)) console.log('错误:', e.slice(0, 600))
  console.log('其他错误:', errors.filter((e) => !e.includes('185') && !e.includes('Maximum')).slice(0, 5).join('\n') || '(无)')
  console.log('页面文本片段:', body.slice(0, 120).replace(/\n/g, ' | '))
  await page.screenshot({ path: 'e2e-185b.png', fullPage: false })
  console.log('screenshot: e2e-185b.png')
} finally {
  await browser.close()
}
