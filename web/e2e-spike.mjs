// E2E v2：真实 Chrome 无头验证，超时兜底转储现场。
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
})
try {
  const page = await browser.newPage()
  const logs = []
  const nets = []
  page.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`))
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  page.on('response', (r) => {
    if (r.url().includes('/v1/chat')) nets.push(`[chat-resp] ${r.status()} hdr=${r.headers()['x-vercel-ai-ui-message-stream'] ?? '-'}`)
  })

  await page.goto('http://localhost:5173/spike', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('button[type="submit"]', { timeout: 20000 }).catch(() => console.log('NO SUBMIT BTN'))
  await page.waitForFunction(
    () => document.querySelector('input') !== null,
    { timeout: 15000 },
  ).catch(() => console.log('NO INPUT'))

  // React 受控输入：原生 setter + input 事件
  await page.evaluate(() => {
    const el = document.querySelector('input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(el, '/quiz 1道一元二次方程')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  const typed = await page.evaluate(() => document.querySelector('input').value)
  console.log('input value after set:', JSON.stringify(typed))
  await page.click('button:not([disabled])')
  console.log('clicked submit, waiting 35s...')
  await new Promise((r) => setTimeout(r, 35000))

  const bodyText = await page.evaluate(() => document.body.innerText)
  console.log('==== 页面文本（前 3000）====')
  console.log(bodyText.slice(0, 3000))
  console.log('==== 控制台日志 ====')
  console.log(logs.join('\n').slice(0, 3000) || '(空)')
  console.log('==== 网络 ====')
  console.log(nets.join('\n') || '(无 chat 请求)')
  await page.screenshot({ path: 'e2e-debug.png' }).catch(() => {})
  console.log('screenshot saved: e2e-debug.png')
} finally {
  await browser.close()
}
