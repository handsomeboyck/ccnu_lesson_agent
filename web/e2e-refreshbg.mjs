// 刷新恢复 + 后台生成：带 API 真值检查
import puppeteer from 'puppeteer-core'
const API = 'http://127.0.0.1:8080'
const u = 'frg-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
const p = await b.newPage()
await p.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' })
await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
await p.goto('http://localhost:5173/chat', { waitUntil: 'domcontentloaded' })
await p.waitForSelector('textarea', { timeout: 20000 })
await new Promise((r) => setTimeout(r, 1000))
await p.evaluate(() => {
  const el = document.querySelector('textarea')
  const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  s.call(el, '写一篇600字关于阅读习惯的文章')
  el.dispatchEvent(new Event('input', { bubbles: true }))
})
await new Promise((r) => setTimeout(r, 300))
await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
await new Promise((r) => setTimeout(r, 1500))
const convId = await p.evaluate(() => localStorage.getItem('ccnu-last-conv'))
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForSelector('textarea', { timeout: 20000 })
await new Promise((r) => setTimeout(r, 3000))
const s1 = await p.evaluate(() => ({ banner: document.body.innerText.includes('正在后台生成中'), len: document.body.innerText.length }))
console.log('刷新后 生成中提示:', s1.banner ? '✓' : '✗')
// API 真值：等生成完成
let wait = 0
while (wait < 90000) {
  const g = await (await fetch(`${API}/v1/chat/generating`, { headers: H })).json()
  if (!g.generating.some((x) => x.conversation_id === convId)) break
  await new Promise((r) => setTimeout(r, 3000))
  wait += 3000
}
console.log('API 侧生成完成（等', wait / 1000, 's）')
const msgs = await (await fetch(`${API}/v1/conversations/${convId}/messages`, { headers: H })).json()
const last = msgs.messages[msgs.messages.length - 1]
console.log('API 落库: role=' + last?.role + ' len=' + (last?.content || '').length)
// 前端此时应已自动加载
await new Promise((r) => setTimeout(r, 5000))
const s2 = await p.evaluate(() => ({ len: document.body.innerText.length, hasReply: document.body.innerText.includes('阅读习惯') && (document.body.innerText.includes('首先') || document.body.innerText.includes('建议') || document.body.innerText.includes('养成') || document.body.innerText.includes('每天')) }))
console.log('前端自动加载:', s2.len > s1.len + 300 ? '✓ (文本+' + (s2.len - s1.len) + ')' : '✗ (仍 ' + s2.len + ')', '| 正文完整:', s2.hasReply ? '✓' : '✗')
await b.close()
