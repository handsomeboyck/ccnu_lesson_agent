// 复现 React #185：全流程跑测 + 抓完整错误堆栈（dev 未压缩）
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SITE = process.env.SITE ?? 'http://localhost:5173'
const API = process.env.API ?? 'http://127.0.0.1:8080'

async function login() {
  const u = 'err-' + Math.random().toString(36).slice(2, 8)
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
  page.on('console', (m) => {
    const t = m.text()
    if (m.type() === 'error' || /#185|Maximum update depth|above error/.test(t)) logs.push(`[console.${m.type()}] ${t}`)
  })
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  await page.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  // 注入 console 拦截：捕获错误时的调用堆栈（含 React 组件栈）
  await page.evaluateOnNewDocument(() => {
    window.__errs = []
    const orig = console.error
    console.error = (...args) => {
      const parts = args.map((a) =>
        typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack ?? ''}` : safeStr(a),
      )
      window.__errs.push(parts.join(' '))
      orig(...args)
    }
    function safeStr(a) {
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    }
  })
  await page.evaluate(
    ({ t, u }) => {
      localStorage.setItem(
        'ccnu-auth',
        JSON.stringify({ state: { user: u, accessToken: t, refreshToken: 'x' }, version: 0 }),
      )
    },
    { t: token, u: user },
  )
  await page.goto(SITE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1000))

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

  // 1. ask 流程（思考+工具+提问）
  await setText('帮我出几道题吧')
  await new Promise((r) => setTimeout(r, 300))
  await send()
  await waitEnd()
  await new Promise((r) => setTimeout(r, 800))

  // 2. 点击选项续接
  const clicked = await page.evaluate(() => {
    const b = document.querySelector('[data-ask-option]')
    if (!b) return false
    b.click()
    return true
  })
  if (clicked) {
    await waitEnd()
    await new Promise((r) => setTimeout(r, 800))
  }

  // 3. 刷新 + 历史回看
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500))
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('div')].filter(
      (d) => d.className && typeof d.className === 'string' && d.className.includes('cursor-pointer'),
    )
    items[0]?.click()
  })
  await new Promise((r) => setTimeout(r, 2500))

  // 4. 新对话 → 工具流
  await page.evaluate(() => {
    const nb = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('新对话'))
    nb?.click()
  })
  await new Promise((r) => setTimeout(r, 600))
  await setText('/quiz 1道一元二次方程')
  await new Promise((r) => setTimeout(r, 300))
  await send()
  await waitEnd()
  await new Promise((r) => setTimeout(r, 800))

  // 5. 纯问答
  await setText('9.11 和 9.8 哪个大？')
  await new Promise((r) => setTimeout(r, 300))
  await send()
  await waitEnd()
  await new Promise((r) => setTimeout(r, 800))

  // 6. execute_code 长参数（生产有 codex 沙箱；本地跳过）
  if (SITE.includes('https')) {
    await setText('用 python 生成一个正弦函数图像并保存为 png')
    await new Promise((r) => setTimeout(r, 300))
    await send()
    await waitEnd(180000)
    await new Promise((r) => setTimeout(r, 1000))
  }

  // 7. 边缘操作：发送后立即停止 → 再发；流中切换会话；选项连点
  await setText('请详细讲解一下导数是什么，字数越多越好')
  await new Promise((r) => setTimeout(r, 300))
  await send()
  await new Promise((r) => setTimeout(r, 400))
  const stopped = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.querySelector('svg.lucide-square'))
    b?.click()
    return !!b
  })
  console.log('中途停止:', stopped ? '✓' : '✗（未捕获到停止按钮）')
  await new Promise((r) => setTimeout(r, 1500))

  // 快速再发（停止后立即重发）
  await setText('继续讲')
  await new Promise((r) => setTimeout(r, 200))
  await send()
  await waitEnd()
  await new Promise((r) => setTimeout(r, 800))

  // 流中切换会话（先发一条长回答，1 秒后点历史会话）
  await setText('写一篇 500 字的关于学习方法的短文')
  await new Promise((r) => setTimeout(r, 200))
  await send()
  await new Promise((r) => setTimeout(r, 1000))
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('div')].filter(
      (d) => d.className && typeof d.className === 'string' && d.className.includes('cursor-pointer'),
    )
    items[items.length - 1]?.click() // 切到另一会话（若存在）
  })
  await waitEnd(120000)
  await new Promise((r) => setTimeout(r, 800))

  // ask 选项连点（快速点两次）
  await setText('帮我出几道题吧')
  await new Promise((r) => setTimeout(r, 300))
  await send()
  await waitEnd()
  await new Promise((r) => setTimeout(r, 500))
  const dbl = await page.evaluate(() => {
    const b = document.querySelector('[data-ask-option]')
    if (!b) return false
    b.click()
    b.click()
    return true
  })
  console.log('选项连点:', dbl ? '✓' : '✗（本次无选项）')
  await waitEnd()
  await new Promise((r) => setTimeout(r, 800))

  console.log('==== 捕获的错误（完整）====')
  console.log(logs.join('\n\n') || '(无)')
  const errs = await page.evaluate(() => (window.__errs ?? []).slice(0, 6))
  console.log('==== 页面侧堆栈（前 6 条）====')
  console.log(errs.join('\n\n---\n').slice(0, 6000) || '(无)')
  const msgs = await page.evaluate(() => (window.__messages ?? []).map((m) => `${m.role}:${m.id}`))
  console.log('==== 最终 messages（id 列表）====')
  console.log(msgs.join('\n'))
  const dup = await page.evaluate(() => {
    const all = (window.__messages ?? []).map((m) => m.id)
    const seen = new Map()
    for (const id of all) seen.set(id, (seen.get(id) ?? 0) + 1)
    return [...seen.entries()].filter(([, n]) => n > 1)
  })
  console.log('==== 重复 id ====')
  console.log(JSON.stringify(dup) || '(无)')
  console.log('==== 结束 ====')
} finally {
  await browser.close()
}
