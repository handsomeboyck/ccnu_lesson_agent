// 生产：生成中刷新（用稳定长答 prompt：代码生成）
import puppeteer from 'puppeteer-core'
const API = 'https://www.ccnu.chat'
const SITE = 'https://www.ccnu.chat'
const u = 'rs8-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const p = await b.newPage()
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500))
  // 用代码生成（稳定长回复）
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请用 Python 写一个 30 行的猜数字游戏，逐行注释，输出完整代码')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await new Promise((r) => setTimeout(r, 2000)) // 生成中刷新
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 3000))
  const s1 = await p.evaluate(() => ({
    map: localStorage.getItem('ccnu-stream-map'),
    restored: document.body.innerText.includes('猜数字'),
  }))
  console.log('刷新后: 会话恢复=' + (s1.restored ? '✓' : '✗') + ' | streamMap=' + (s1.map ? '✓' : '✗'))
  await new Promise((r) => setTimeout(r, 30000))
  const s2 = await p.evaluate(() => {
    const t = document.body.innerText
    return { len: t.length, hasCode: t.includes('import random') || t.includes('def ') || t.includes('while'), map: localStorage.getItem('ccnu-stream-map') }
  })
  console.log('刷新后完整代码回复:', s2.hasCode ? '✓ (' + s2.len + '字)' : '✗ (' + s2.len + ')', '| streamMap 清理:', s2.map === '{}' ? '✓' : '✗')
} finally {
  await b.close()
}
