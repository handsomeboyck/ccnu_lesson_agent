// 循环复现 #185：最多 4 次（每次新对话+上传docx+触发evaluate），抓到 DIAG 栈即停
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'
const DOCX = 'C:/Users/wps/software/work/dsh_workplace/agent/jiaoan.docx'

const u = 'loop-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const page = await browser.newPage()
  const diag = []
  page.on('console', (m) => {
    const t = m.text()
    if (t.includes('DIAG-') || /185|Maximum|update depth/i.test(t)) diag.push(`[${m.type()}] ${t.slice(0, 2000)}`)
  })

  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await page.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1000))

  for (let attempt = 1; attempt <= 4; attempt++) {
    console.log(`==== 第 ${attempt} 次尝试 ====`)
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
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); b?.click() })

    await page
      .waitForFunction(
        () => document.body.innerText.includes('Maximum update depth') || document.body.innerText.includes('Minified React error'),
        { timeout: 100000 },
      )
      .then(() => console.log('>>> 本轮触发 #185 横幅'))
      .catch(() => console.log('(本轮未触发横幅)'))

    if (diag.length > 0) break

    // 重置：新对话
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')]
      const nb = btns.find((b) => getComputedStyle(b).display !== 'none' && b.textContent.includes('新对话'))
      nb?.click()
    })
    await new Promise((r) => setTimeout(r, 1200))
  }

  console.log('----DIAG 日志----')
  console.log(diag.slice(0, 6).join('\n=====\n') || '(无)')
} finally {
  await browser.close()
}
