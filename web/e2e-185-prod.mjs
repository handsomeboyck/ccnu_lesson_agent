// 生产验证：#185 修复后 exec_code 与 evaluate_design+docx 两场景
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'https://www.ccnu.chat'
const DOCX = 'C:/Users/wps/software/work/dsh_workplace/agent/jiaoan.docx'

const u = 'p185-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const page = await browser.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error' || /185|Maximum|update depth/i.test(m.text())) errs.push(`[${m.type()}] ${m.text().slice(0, 400)}`)
  })

  await page.goto(`${API}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await page.goto(`${API}/`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500))

  // 场景 1：execute_code（用户高频触发场景）
  await page.evaluate(() => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '用 Python 画一个 sin 曲线图并保存为图片')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); b?.click() })
  await page
    .waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')), { timeout: 180000 })
    .catch(() => console.log('(场景1 流未结束)'))
  await new Promise((r) => setTimeout(r, 2000))
  const t1 = await page.evaluate(() => document.body.innerText)
  const hit1 = t1.includes('Minified React error') || t1.includes('Maximum update depth')
  console.log('场景1 exec_code:', hit1 ? '⚠️ #185 横幅' : '✓ 无 #185', '| 有回复:', t1.length > 500 ? '✓' : '?')

  // 场景 2：新对话 + 上传 docx + evaluate_design
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const nb = btns.find((b) => getComputedStyle(b).display !== 'none' && b.textContent.includes('新对话'))
    nb?.click()
  })
  await new Promise((r) => setTimeout(r, 1200))
  const input = await page.$('input[type=file]')
  await input.uploadFile(DOCX)
  await new Promise((r) => setTimeout(r, 2500))
  await page.evaluate(() => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '请用 /evaluate 评估这份教案')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); b?.click() })
  await page
    .waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')), { timeout: 180000 })
    .catch(() => console.log('(场景2 流未结束)'))
  await new Promise((r) => setTimeout(r, 2000))
  const t2 = await page.evaluate(() => document.body.innerText)
  const hit2 = t2.includes('Minified React error') || t2.includes('Maximum update depth')
  console.log('场景2 evaluate+docx:', hit2 ? '⚠️ #185 横幅' : '✓ 无 #185', '| 有评估输出:', t2.includes('评估') ? '✓' : '?')

  const real = errs.filter((e) => e.includes('185') || e.includes('Maximum') || e.includes('update depth'))
  console.log('控制台 #185:', real.length ? `⚠️ ${real.length} 条` : '✓ 无')
  console.log('其他控制台错误:', errs.filter((e) => !e.includes('185') && !e.includes('Maximum') && !e.includes('update depth')).slice(0, 4).join('\n') || '(无)')
} finally {
  await browser.close()
}
