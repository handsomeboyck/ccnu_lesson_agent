// 性能实测：各场景 wall-time / 首字 / 思考时长 / 工具轮次（生产）
const API = 'https://www.ccnu.chat'

const u = 'perf-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { access_token: token } = await lr.json()

async function run(label, content) {
  const t0 = Date.now()
  let firstText = -1, reasoningStart = -1, reasoningEnd = -1, toolRounds = 0, textLen = 0
  const body = JSON.stringify({ conversation_id: '', content })
  const resp = await fetch(`${API}/v1/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  })
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let finished = false
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue
      const d = l.slice(6).trim()
      if (d === '[DONE]') { finished = true; break }
      let c
      try { c = JSON.parse(d) } catch { continue }
      const now = Date.now() - t0
      switch (c.type) {
        case 'text-start': if (firstText < 0) firstText = now; break
        case 'reasoning-start': if (reasoningStart < 0) reasoningStart = now; break
        case 'reasoning-end': if (reasoningEnd < 0) reasoningEnd = now; break
        case 'tool-input-start': toolRounds++; break
        case 'text-delta': textLen += (c.delta ?? '').length; break
        case 'finish': finished = true; break
      }
    }
    if (finished) break
  }
  const total = Date.now() - t0
  console.log(`${label}:
  总时长 = ${(total / 1000).toFixed(1)}s | 首字(文本) = ${firstText >= 0 ? (firstText / 1000).toFixed(1) + 's' : '-'} | 思考阶段 = ${reasoningStart >= 0 ? (reasoningEnd >= 0 ? (reasoningEnd - reasoningStart) / 1000 : (total - reasoningStart) / 1000).toFixed(1) : '-'}s | 工具轮次 = ${toolRounds} | 文本量 = ${textLen} 字`)
}

console.log('==== 生产性能实测（deepseek-v4-flash, effort=medium）====')
await run('① 普通问答(无工具)', '你好，用一句话介绍你自己')
await run('② explain 讲解(文档技能)', '讲解一下牛顿第一定律')
await run('③ execute_code(代码执行)', '用 Python 画一个 sin 曲线图并保存为图片')
await run('④ evaluate 教案评估(文档技能)', '请用 /evaluate 评估这份教案：目标：掌握一元二次方程概念与求根公式；环节：导入-新授-例题-练习-小结；作业：课后1-5题。')
