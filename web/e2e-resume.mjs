// 验证：① 切换会话再回来渲染正常（不重复/AskCard 完整）② 刷新后不断开（localStorage streamMap 恢复）
import puppeteer from 'puppeteer-core'
const API = process.env.API || 'http://127.0.0.1:8080'
const SITE = process.env.SITE || API
const u = 'rs-' + Math.random().toString(36).slice(2, 8)
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

  // ---- 场景A：触发 ask（出题）----
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
  const liveBtns = await p.evaluate(() => [...document.querySelectorAll('button')].filter((x) => x.textContent.trim().length >= 4 && x.textContent.trim().length <= 25).map((x) => x.textContent.trim()).slice(0, 8))
  console.log('live ask 选项按钮:', liveBtns.length >= 2 ? '✓' : '✗', JSON.stringify(liveBtns))

  // ---- 场景B：切走再切回（渲染正常，不重复）----
  // 新对话（切走）
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('新对话')); btn?.click() })
  await new Promise((r) => setTimeout(r, 1200))
  // 切回原会话（侧栏第一项）
  await p.evaluate(() => {
    const items = [...document.querySelectorAll('aside button, aside a')]
    const target = items.find((x) => x.textContent.includes('勾股定理'))
    target?.click()
  })
  await new Promise((r) => setTimeout(r, 3500))
  const back = await p.evaluate(() => {
    const t = document.body.innerText
    const askCards = (t.match(/提问正在向你提问/g) || []).length
    const optCount = [...document.querySelectorAll('button')].filter((x) => x.textContent.trim().length >= 4 && x.textContent.trim().length <= 25 && !['新对话', '我的资料库', '我的文件', '学习功能', '退出登录'].includes(x.textContent.trim())).length
    return { askCards, optCount }
  })
  console.log('切回后 ask 卡数量(应=1):', back.askCards, back.askCards === 1 ? '✓' : '✗')
  console.log('切回后选项按钮(应≥2):', back.optCount, back.optCount >= 2 ? '✓' : '✗')

  // ---- 场景C：刷新后不断开（streamMap 恢复 → watchGeneration）----
  // 先发一个长生成任务
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请详细讲解牛顿三大定律，写一篇长文章')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await new Promise((r) => setTimeout(r, 2500))
  const streamMapBefore = await p.evaluate(() => localStorage.getItem('ccnu-stream-map'))
  console.log('刷新前 streamMap:', streamMapBefore ? '✓ 已持久化' : '✗ 空')
  // 刷新
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 2500))
  const afterReload = await p.evaluate(() => ({
    banner: document.body.innerText.includes('正在后台生成中'),
    streamMap: localStorage.getItem('ccnu-stream-map'),
  }))
  console.log('刷新后: streamMap 恢复:', afterReload.streamMap ? '✓' : '✗', '| 生成中提示:', afterReload.banner ? '✓' : '(可能已快速完成)')
  // 等生成完成自动加载
  await new Promise((r) => setTimeout(r, 30000))
  const final = await p.evaluate(() => {
    const t = document.body.innerText
    return { hasNewton: t.includes('牛顿') && t.length > 300, len: t.length, streamMap: localStorage.getItem('ccnu-stream-map') }
  })
  console.log('刷新后完整回复加载:', final.hasNewton ? '✓ (' + final.len + '字)' : '✗ (仍 ' + final.len + ')')
  console.log('streamMap 已清理:', final.streamMap === '{}' || !final.streamMap ? '✓' : '✗')
  console.log('控制台错误:', errs.length ? errs.slice(0, 2).join(' | ') : '(无)')
} finally {
  await b.close()
}
