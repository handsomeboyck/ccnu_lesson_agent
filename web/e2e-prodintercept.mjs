// 生产：刷新后拦截 fetch 验证 watchGeneration 是否请求 /v1/chat/stream
import puppeteer from 'puppeteer-core'
const API = 'https://www.ccnu.chat'
const SITE = 'https://www.ccnu.chat'
const u = 'rs9-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const p = await b.newPage()
  // 拦截 fetch：记录对 /v1/chat/stream 的调用
  await p.evaluateOnNewDocument(() => {
    const orig = window.fetch
    window.__streamCalls = []
    window.fetch = (...args) => {
      const url = String(args[0])
      if (url.includes('/v1/chat/stream')) window.__streamCalls.push({ url, at: Date.now() })
      return orig(...args)
    }
  })
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500))
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请用 Python 写一个 30 行的猜数字游戏，逐行注释')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await new Promise((r) => setTimeout(r, 2000))
  const callsBefore = await p.evaluate(() => window.__streamCalls.length)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 5000))
  const callsAfter = await p.evaluate(() => window.__streamCalls.map((c) => c.url.slice(0, 60)))
  const st = await p.evaluate(() => ({
    restored: document.body.innerText.includes('猜数字'),
    map: localStorage.getItem('ccnu-stream-map'),
  }))
  console.log('刷新前 stream fetch 调用:', callsBefore)
  console.log('刷新后 stream fetch 调用:', JSON.stringify(callsAfter))
  console.log('会话恢复:', st.restored ? '✓' : '✗', '| streamMap:', st.map ? '在' : '空')
  // 等生成完成（最长 60s）
  await new Promise((r) => setTimeout(r, 60000))
  const st2 = await p.evaluate(() => ({
    hasCode: document.body.innerText.includes('import random') || document.body.innerText.includes('def '),
    len: document.body.innerText.length,
    map: localStorage.getItem('ccnu-stream-map'),
  }))
  console.log('60s后 代码回复:', st2.hasCode ? '✓ (' + st2.len + ')' : '✗ (' + st2.len + ')', '| streamMap 清理:', st2.map === '{}' || !st2.map ? '✓' : '✗ (' + st2.map + ')')
} finally {
  await b.close()
}
