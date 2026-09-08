// 诊断版：evaluate_design + docx 全流程取证（DOM + API）
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'
const DOCX = 'C:/Users/wps/software/work/dsh_workplace/agent/jiaoan.docx'

const u = 'diag-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
}).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
})
const { user, access_token: token } = await lr.json()

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
    if (m.type() === 'error') errors.push(`[console.error] ${m.text().slice(0, 400)}`)
  })

  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' })
  await page.evaluate(
    ({ t, u2 }) => {
      localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 }))
    },
    { t: token, u2: user },
  )
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
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送')
    b?.click()
  })

  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')),
    { timeout: 180000 },
  ).catch(() => console.log('(流未结束/超时)'))
  await new Promise((r) => setTimeout(r, 2000))

  const dom = await page.evaluate(() => {
    const body = document.body.innerText
    const errEls = [...document.querySelectorAll('[class*="destructive"]')].map((e) => e.textContent.trim()).filter(Boolean)
    return { tail: body.slice(-700), errEls: errEls.slice(0, 3), hasAsk: body.includes('小艺想先确认') }
  })
  console.log('----DOM----')
  console.log('尾部文本:', JSON.stringify(dom.tail))
  console.log('错误元素:', JSON.stringify(dom.errEls))
  console.log('提问卡:', dom.hasAsk ? '是' : '否')

  // API：取该会话最后消息
  const convs = await fetch(`${API}/v1/conversations`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json())
  const conv = convs.conversations[0]
  if (conv) {
    const msgs = await fetch(`${API}/v1/conversations/${conv.id}/messages`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.json())
    const last = msgs.messages[msgs.messages.length - 1]
    console.log('----服务端最后消息----')
    console.log('role:', last.role, '| 长度:', last.content?.length)
    console.log('内容前 300:', JSON.stringify((last.content ?? '').slice(0, 300)))
  }
  console.log('----控制台错误----')
  console.log(errors.length ? errors.slice(0, 6).join('\n') : '(无)')
  console.log('#185:', errors.some((e) => e.includes('185') || e.includes('Maximum update depth')) ? '⚠️ 出现' : '否')
} finally {
  await browser.close()
}
