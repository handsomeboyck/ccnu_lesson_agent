// E2E v3：真续流验证（在正常开发环境运行：npm run dev + go run ./cmd/api）
// 场景：发送长生成任务 → 生成中刷新页面 → 断言：
//   ① 刷新后立即显示「已生成的部分」（真续流，不是等完成）
//   ② 继续流式到完成（最终内容完整、与 DB 一致）
//   ③ resume state / streamMap 正确清理
// 用法：node e2e-resume-v3.mjs [site] [api]
import puppeteer from 'puppeteer-core'
const SITE = process.argv[2] || 'http://localhost:5173'
const API = process.argv[3] || 'http://127.0.0.1:8080'
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'

const u = 'rv3-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`) }

const b = await (async () => {
  // 沙箱环境：无法 spawn Chrome → 通过 CDP 连接外部启动的 Chrome（CDP_URL 环境变量）
  if (process.env.CDP_URL) {
    return puppeteer.connect({ browserURL: process.env.CDP_URL })
  }
  return puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu'], defaultViewport: { width: 1440, height: 900 } })
})()
try {
  const p = await b.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.goto(`${SITE}/login`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await p.goto(`${SITE}/chat`, { waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1200))

  // ---- 1. 发送长生成任务 ----
  await p.evaluate(() => {
    const el = document.querySelector('textarea')
    const s = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    s.call(el, '请写一篇3000字左右的文章，主题：如何养成好的阅读习惯。请写详细一些，分章节。')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await new Promise((r) => setTimeout(r, 300))
  await p.evaluate(() => { const btn = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); btn?.click() })
  await new Promise((r) => setTimeout(r, 3000)) // 等待生成进行中

  const pre = await p.evaluate(() => ({
    resumeState: localStorage.getItem('ccnu-stream-resume'),
    streamMap: localStorage.getItem('ccnu-stream-map'),
    bodyLen: document.body.innerText.length,
    convId: localStorage.getItem('ccnu-last-conv'),
  }))
  console.log(`刷新前: bodyLen=${pre.bodyLen} resumeState=${pre.resumeState ? '✓' : '✗'} streamMap=${pre.streamMap ? '✓' : '✗'} convId=${pre.convId ? '✓' : '✗'}`)
  check('生成中已持久化断点状态 (ccnu-stream-resume)', !!pre.resumeState)
  check('生成中已持久化 streamMap', !!pre.streamMap)
  check('已有部分输出', pre.bodyLen > 200, `len=${pre.bodyLen}`)

  // ---- 2. 生成中刷新 ----
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 2500)) // 给恢复+续流时间

  // ③ 关键断言：刷新后【立即】看到已生成的部分（真续流核心：半截内容直接渲染）
  const mid = await p.evaluate(() => ({
    bodyLen: document.body.innerText.length,
    hasPartial: document.body.innerText.length > 300,
    resumeState: localStorage.getItem('ccnu-stream-resume'),
  }))
  console.log(`刷新后 2.5s: bodyLen=${mid.bodyLen} resumeState=${mid.resumeState ? '仍在' : '已清'}`)
  check('刷新后立即显示已生成部分（真续流）', mid.bodyLen > pre.bodyLen * 0.5 && mid.bodyLen > 300, `len=${mid.bodyLen}`)

  // ---- 3. 等生成完成 ----
  await new Promise((r) => setTimeout(r, 45000))
  const final = await p.evaluate(() => {
    const t = document.body.innerText
    return {
      len: t.length,
      hasContent: t.includes('阅读习惯') && t.length > 1000,
      resumeState: localStorage.getItem('ccnu-stream-resume'),
      streamMap: localStorage.getItem('ccnu-stream-map'),
    }
  })
  console.log(`完成后: bodyLen=${final.len} resumeState=${final.resumeState ? '残留✗' : '已清✓'} streamMap=${final.streamMap && final.streamMap !== '{}' ? '残留✗' : '已清✓'}`)
  check('完成后显示完整内容', final.hasContent, `len=${final.len}`)
  check('完成后断点状态已清理', !final.resumeState)
  check('完成后 streamMap 已清理', !final.streamMap || final.streamMap === '{}')
  check('无页面错误', errs.length === 0, errs.slice(0, 2).join(' | '))

  // ---- 4. 与 DB 对比 ----
  if (pre.convId) {
    const msgs = await (await fetch(`${API}/v1/conversations/${pre.convId}/messages`, { headers: { Authorization: `Bearer ${token}` } })).json()
    const last = msgs.messages[msgs.messages.length - 1]
    check('DB 权威内容完整', last?.role === 'assistant' && (last.content || '').length > 1000, `len=${(last?.content || '').length}`)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n==== 结果: ${results.length - failed.length}/${results.length} 通过 ====`)
  process.exit(failed.length ? 1 : 0)
} finally {
  await b.close()
}
