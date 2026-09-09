// 关键场景：① 生成中刷新 ② 生成中切走再切回
import puppeteer from 'puppeteer-core'
const API = process.env.API || 'http://127.0.0.1:8080'
const SITE = process.env.SITE || API
const u = 'rs5-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
try {
  const p = await b.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1200))

  // ===== 场景① 生成中刷新 =====
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请写一篇1000字关于学习方法的长文章')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await new Promise((r) => setTimeout(r, 2000)) // 生成中刷新
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 3000))
  const s1 = await p.evaluate(() => ({
    banner: document.body.innerText.includes('正在后台生成中'),
    map: localStorage.getItem('ccnu-stream-map'),
    restored: document.body.innerText.includes('学习方法'),
  }))
  console.log('生成中刷新: 会话恢复=' + (s1.restored ? '✓' : '✗') + ' | streamMap=' + (s1.map ? '✓' : '✗') + ' | 生成中提示=' + (s1.banner ? '✓' : '(可能很快完成)'))
  await new Promise((r) => setTimeout(r, 30000))
  const s2 = await p.evaluate(() => {
    const t = document.body.innerText
    return { len: t.length, hasArticle: t.includes('学习方法') && t.length > 400, map: localStorage.getItem('ccnu-stream-map') }
  })
  console.log('生成中刷新后完整回复:', s2.hasArticle ? '✓ (' + s2.len + '字)' : '✗ (' + s2.len + ')', '| streamMap 清理:', s2.map === '{}' ? '✓' : '✗')

  // ===== 场景② 生成中切走再切回 =====
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请写一篇1000字关于记忆方法的长文章')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await new Promise((r) => setTimeout(r, 2000)) // 生成中
  // 切走（新对话）
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新对话')); btn?.click() })
  await new Promise((r) => setTimeout(r, 1200))
  // 切回（点侧栏 记忆方法 会话）
  const clicked = await p.evaluate(() => {
    const items = [...document.querySelectorAll('aside div')]
    const target = items.find((x) => x.textContent.includes('记忆方法') && x.className.includes('cursor-pointer'))
    if (!target) return false
    target.click(); return true
  })
  await new Promise((r) => setTimeout(r, 3500))
  const s3 = await p.evaluate(() => ({
    banner: document.body.innerText.includes('正在后台生成中'),
    snippet: (document.querySelector('main')?.innerText || '').slice(0, 120).replace(/\n/g, ' | '),
  }))
  console.log('生成中切回: 提示=' + (s3.banner ? '✓' : '(可能已完成)') + ' | 主区: ' + s3.snippet)
  await new Promise((r) => setTimeout(r, 30000))
  const s4 = await p.evaluate(() => {
    const t = document.querySelector('main')?.innerText || ''
    return { len: t.length, hasArticle: t.includes('记忆方法') && t.length > 400, dup: (t.match(/记忆方法/g) || []).length, map: localStorage.getItem('ccnu-stream-map') }
  })
  console.log('生成中切回后: 完整回复=' + (s4.hasArticle ? '✓ (' + s4.len + '字)' : '✗ (' + s4.len + ')') + ' | 重复数=' + s4.dup + ' | streamMap=' + (s4.map === '{}' ? '✓ 清理' : '✗'))
  console.log('控制台错误:', errs.length ? errs.slice(0, 2).join(' | ') : '(无)')
} finally {
  await b.close()
}
