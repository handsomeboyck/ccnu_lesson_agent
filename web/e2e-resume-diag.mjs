// 诊断：切回后 DOM 状态 + streamMap 清理
import puppeteer from 'puppeteer-core'
const API = 'http://127.0.0.1:8080'
const SITE = 'http://localhost:5173'
const u = 'rsd-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()

const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const p = await b.newPage()
  const logs = []
  p.on('console', (m) => { const t = m.text(); if (t.includes('watchGen') || t.includes('streamMap')) logs.push(t) })
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1200))

  // 触发 ask
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '出几道勾股定理练习题')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await p.waitForFunction(() => document.body.innerText.includes('提问正在向你提问'), { timeout: 60000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, 1500))

  // 切走再切回
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新对话')); btn?.click() })
  await new Promise((r) => setTimeout(r, 1200))
  await p.evaluate(() => { [...document.querySelectorAll('aside button, aside a')].find((x) => x.textContent.includes('勾股定理'))?.click() })
  await new Promise((r) => setTimeout(r, 3500))
  const dom = await p.evaluate(() => {
    const askEls = [...document.querySelectorAll('[class*="ask"], [class*="Ask"]')]
    const btns = [...document.querySelectorAll('button')].map((x) => x.textContent.trim()).filter((t) => t.length >= 2 && t.length <= 30)
    const main = document.querySelector('main')
    const mainText = main?.innerText || ''
    return {
      askEls: askEls.length,
      btns: [...new Set(btns)].slice(0, 15),
      mainSnippet: mainText.slice(0, 400).replace(/\n/g, ' | '),
      streamMap: localStorage.getItem('ccnu-stream-map'),
    }
  })
  console.log('ask 元素数:', dom.askEls)
  console.log('按钮:', JSON.stringify(dom.btns))
  console.log('主区内容:', dom.mainSnippet)
  console.log('streamMap:', dom.streamMap)
  await b.close()
} finally { if (b) await b.close() }
