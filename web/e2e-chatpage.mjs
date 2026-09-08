// ChatPage v2 E2E：真实 Chrome 验证新聊天页（工具卡 / 提问卡 / 文本流 / 续接）。
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'

async function login() {
  const u = 'chat-e2e-' + Math.random().toString(36).slice(2, 8)
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

function setTextarea(page, value) {
  return page.evaluate((v) => {
    const el = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
}

function clickSend(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')]
    const send = btns.find((b) => b.title === '发送')
    if (!send) throw new Error('send button not found')
    send.click()
  })
}

function waitStreamEnd(page, timeout = 120000) {
  return page.waitForFunction(
    () => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')),
    { timeout },
  )
}

const { user, access_token: token } = await login()
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'] })
try {
  const page = await browser.newPage()
  const logs = []
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') logs.push(`[console.error] ${m.text()}`)
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
  await new Promise((r) => setTimeout(r, 1200))

  // ---- 场景 1：/quiz 工具流 ----
  await setTextarea(page, '/quiz 1道一元二次方程')
  await new Promise((r) => setTimeout(r, 300))
  await clickSend(page)
  await waitStreamEnd(page)
  await new Promise((r) => setTimeout(r, 600))
  let text = await page.evaluate(() => document.body.innerText)
  console.log('== 场景1 工具流 ==')
  console.log('工具卡:', text.includes('quiz_generator') ? '✓ 出现' : '✗ 缺失')
  console.log('状态字:', text.includes('执行中') || text.includes('技能「quiz_generator」执行完成') ? '✓' : '?')
  console.log('Markdown 文本:', text.includes('一元二次方程 · 练习') ? '✓' : '✗')
  console.log('复制按钮:', text.includes('复制') ? '✓' : '?')

  // ---- 场景 2：ask 提问流（信息不足触发 ask_user）----
  await setTextarea(page, '帮我出几道题吧')
  await new Promise((r) => setTimeout(r, 300))
  await clickSend(page)
  await waitStreamEnd(page)
  await new Promise((r) => setTimeout(r, 600))
  text = await page.evaluate(() => document.body.innerText)
  console.log('== 场景2 ask 提问卡 ==')
  console.log('提问卡:', text.includes('小毅想先确认一个问题') ? '✓ 出现' : '✗ 缺失')
  const options = await page.evaluate(() => {
    const ask = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim().length > 0 && b.textContent.trim().length < 20)
    return ask.map((b) => b.textContent.trim()).slice(0, 8)
  })
  console.log('页面按钮:', JSON.stringify(options))

  // ---- 场景 3：点击选项回答 → 续接 ----
  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('[data-ask-option]')
    if (!btn) return false
    btn.click()
    return true
  })
  console.log('点击选项:', clicked ? '✓' : '✗（未找到匹配选项）')
  if (clicked) {
    await waitStreamEnd(page)
    await new Promise((r) => setTimeout(r, 800))
    text = await page.evaluate(() => document.body.innerText)
    console.log('== 场景3 续接 ==')
    console.log('续接回复:', text.includes('答案') || text.includes('练习') || text.includes('题') ? '✓ 有回复' : '? 检查文本')
  }

  console.log('== 控制台错误 ==')
  console.log(logs.join('\n') || '(无)')
  await page.screenshot({ path: 'e2e-chatpage.png' })
  console.log('screenshot: e2e-chatpage.png')

  // ---- 场景 4：刷新页面 → 历史会话回看（tool_steps 持久化渲染）----
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500))
  const convClicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('div')].filter(
      (d) => d.className && typeof d.className === 'string' && d.className.includes('cursor-pointer'),
    )
    if (items.length === 0) return false
    items[0].click()
    return true
  })
  console.log('== 场景4 历史会话 ==')
  console.log('点击历史会话:', convClicked ? '✓' : '✗')
  await new Promise((r) => setTimeout(r, 2500))
  const histText = await page.evaluate(() => document.body.innerText)
  console.log('历史文本渲染:', histText.includes('一元二次方程') ? '✓' : '✗')
  console.log('历史工具卡:', histText.includes('quiz_generator') || histText.includes('ask_user') ? '✓' : '✗')
  console.log('历史思考卡:', histText.includes('思考过程') ? '✓' : '✗')
  console.log('历史提问卡:', histText.includes('小毅想先确认一个问题') ? '✓' : '✗')
  console.log('== 场景4 控制台错误 ==')
  console.log(logs.join('\n') || '(无)')

  // ---- 场景 5：消息级附件（txt 上传 → 模型读取内容）----
  const fs = await import('node:fs')
  fs.writeFileSync('e2e-attach.txt', '这是测试附件内容，包含特殊标记 XYZ789 苹果香蕉。', 'utf8')
  await page.evaluate(() => {
    // 新对话，避免上下文干扰
    const btns = [...document.querySelectorAll('button')]
    const nb = btns.find((b) => b.textContent.includes('新对话'))
    nb?.click()
  })
  await new Promise((r) => setTimeout(r, 800))
  const fileInput = await page.$('input[type="file"]')
  await fileInput.uploadFile('e2e-attach.txt')
  await new Promise((r) => setTimeout(r, 1500)) // 附件 chips 出现 + 上传解析
  await setTextarea(page, '这个文件里写了什么内容？')
  await new Promise((r) => setTimeout(r, 300))
  await clickSend(page)
  await waitStreamEnd(page, 150000)
  await new Promise((r) => setTimeout(r, 800))
  const attachText = await page.evaluate(() => document.body.innerText)
  console.log('== 场景5 附件 ==')
  console.log('附件chips:', attachText.includes('e2e-attach.txt') ? '✓' : '✗')
  console.log('模型读到内容:', attachText.includes('XYZ789') || attachText.includes('苹果香蕉') ? '✓' : '✗')
  console.log('== 场景5 控制台错误 ==')
  console.log(logs.join('\n') || '(无)')
  fs.rmSync('e2e-attach.txt', { force: true })
} finally {
  await browser.close()
}
