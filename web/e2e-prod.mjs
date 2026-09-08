// 生产环境端到端验收：https://www.ccnu.chat 与 https://ccnu.chat
// 注册 → 登录 → 发送消息 → 验证新 UI 与流式回复。
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SITE = process.env.SITE ?? 'https://www.ccnu.chat'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
try {
  const page = await browser.newPage()
  const logs = []
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(`[console.error] ${m.text()}`)
  })

  // 1. 站点可达 + TLS
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30000 })
  const tlsOk = page.url().startsWith('https://')
  console.log(`${SITE} TLS 可达:`, tlsOk ? '✓' : '✗')

  // 2. 注册页
  await page.goto(`${SITE}/register`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('input', { timeout: 15000 })
  await new Promise((r) => setTimeout(r, 800))
  let text = await page.evaluate(() => document.body.innerText)
  console.log('注册页渲染:', text.includes('创建账号') ? '✓' : '✗')

  // 3. 注册 + 自动登录（输入顺序：用户名 / 昵称 / 密码 / 确认密码）
  const u = 'prod-' + Math.random().toString(36).slice(2, 10)
  const inputs = await page.$$('input')
  await inputs[0].type(u)
  await inputs[2].type('ProdTest-123')
  await inputs[3].type('ProdTest-123')
  await new Promise((r) => setTimeout(r, 300))
  const btn = await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.includes('注 册')))
  await btn.asElement().click()
  // 等待跳转到聊天页（textarea 出现）
  await page.waitForSelector('textarea', { timeout: 60000 })
  console.log('注册并进入聊天页: ✓')

  // 4. 发送真实消息
  await new Promise((r) => setTimeout(r, 1200))
  await page.evaluate(() => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '你好，请用一句话介绍你自己')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await page.evaluate(() => {
    const send = [...document.querySelectorAll('button')].find((b) => b.title === '发送')
    send?.click()
  })
  await page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')),
    { timeout: 120000 },
  )
  await new Promise((r) => setTimeout(r, 800))
  text = await page.evaluate(() => document.body.innerText)
  const hasReply = /学伴|你好|教育/.test(text) && !text.includes('Failed to fetch')
  console.log('流式回复渲染:', hasReply ? '✓' : '✗（检查页面文本）')
  console.log('页面片段:', text.slice(0, 220).replace(/\n+/g, ' | '))

  // 5. 控制台错误
  console.log('== 控制台错误 ==')
  console.log(logs.join('\n') || '(无)')
  await page.screenshot({ path: `e2e-prod-${new URL(SITE).hostname}.png` })
  console.log('screenshot saved')
} finally {
  await browser.close()
}
