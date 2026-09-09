// 生产诊断：刷新前 streamMap 是否写入 + 刷新后 watchGen 是否调用
import puppeteer from 'puppeteer-core'
const API = 'https://www.ccnu.chat'
const SITE = 'https://www.ccnu.chat'
const u = 'rs7-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const p = await b.newPage()
  const logs = []
  p.on('console', (m) => { const t = m.text(); if (t.includes('[watchGen]')) logs.push(t) })
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1500))
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请写一篇1000字关于学习方法的长文章')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  // 每 1s 检查 streamMap
  for (let i = 1; i <= 5; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    const map = await p.evaluate(() => localStorage.getItem('ccnu-stream-map'))
    const gen = await p.evaluate(() => document.body.innerText.includes('正在后台生成中') || document.body.innerText.length)
    console.log(`发送后${i}s: streamMap=${map} | bodyLen=${gen}`)
  }
} finally {
  await b.close()
}
