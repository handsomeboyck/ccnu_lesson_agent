// E2E：流式输出时上滑不被自动下拉拽回；回到底部后恢复跟随
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const API = 'http://127.0.0.1:8080'

const u = 'scr4-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { user, access_token: token } = await lr.json()

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-sandbox', '--disable-gpu'],
  defaultViewport: { width: 1440, height: 700 },
})
try {
  const page = await browser.newPage()
  const errs = []
  page.on('pageerror', (e) => errs.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)) })

  await page.goto('http://localhost:5173/login', { waitUntil: 'domcontentloaded' })
  await page.evaluate(({ t, u2 }) => { localStorage.setItem('ccnu-auth', JSON.stringify({ state: { user: u2, accessToken: t, refreshToken: 'x' }, version: 0 })) }, { t: token, u2: user })
  await page.goto('http://localhost:5173/chat', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('textarea', { timeout: 20000 })
  await new Promise((r) => setTimeout(r, 1000))

  // 消息区滚动容器：读/写都在页面内完成，只返回普通对象（勿返回 DOM 节点）
  const boxStats = () =>
    page.evaluate(() => {
      const main = document.querySelector('main')
      const d = main && [...main.querySelectorAll('div')].find((x) => getComputedStyle(x).overflowY === 'auto' && x.clientWidth > 400 && x.scrollHeight > x.clientHeight)
      return d ? { found: true, top: d.scrollTop, sh: d.scrollHeight, ch: d.clientHeight } : { found: false }
    })
  const boxSetTop = (v) =>
    page.evaluate(
      (val) => {
        const main = document.querySelector('main')
        const d = main && [...main.querySelectorAll('div')].find((x) => getComputedStyle(x).overflowY === 'auto' && x.clientWidth > 400 && x.scrollHeight > x.clientHeight)
        if (d) d.scrollTop = val
      },
      v,
    )

  const send = async (text) => {
    await page.evaluate((t) => {
      const el = document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(el, t)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }, text)
    await new Promise((r) => setTimeout(r, 300))
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.title === '发送'); b?.click() })
  }
  const waitStreamEnd = () =>
    page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.querySelector('svg.lucide-square')), { timeout: 120000 }).catch(() => {})

  // 攒消息直到出现可滚动容器（最多 5 条）
  const fillers = [
    '讲解一下牛顿第一定律，尽量详细一些',
    '再讲一下惯性质量的概念和作用，举例说明',
    '那摩擦力和惯性有什么关系？详细展开讲讲',
    '最后说说牛顿第二定律和第一定律的区别',
  ]
  let st = { found: false }
  for (let i = 0; i < fillers.length && !st.found; i++) {
    await send(fillers[i])
    await waitStreamEnd()
    await new Promise((r) => setTimeout(r, 600))
    st = await boxStats()
  }
  console.log('滚动容器出现:', st.found ? '✓' : '✗')

  // 新一条流式中：上滑到顶 → 不应被拽回
  await send('那摩擦力、惯性和运动状态之间到底是什么关系？请从头到尾详细梳理一遍')
  await page.waitForFunction(() => document.body.innerText.includes('关系'), { timeout: 60000 }).catch(() => {})
  await boxSetTop(0)
  await new Promise((r) => setTimeout(r, 3000)) // 流式继续中
  const during = await boxStats()
  console.log('流式中上滑后 scrollTop:', during.found ? Math.round(during.top) : -1, during.found && during.top < 60 ? '（✓ 未被拽回）' : '（✗ 被拽回）')
  await waitStreamEnd()
  await new Promise((r) => setTimeout(r, 800))

  // 回顶部再发一条 → 发送置 stick=true → 自动跟随到底
  await boxSetTop(0)
  await new Promise((r) => setTimeout(r, 300))
  await send('最后用三句话总结一下今天讲的内容')
  await new Promise((r) => setTimeout(r, 4000)) // 流式中
  const after = await boxStats()
  console.log('发送后跟随到底:', after.found && after.sh - after.top - after.ch < 200 ? '✓' : `✗（top=${after.found ? Math.round(after.top) : -1}）`)
  console.log('控制台错误:', errs.length ? errs.slice(0, 3).join(' | ') : '(无)')
} finally {
  await browser.close()
}
