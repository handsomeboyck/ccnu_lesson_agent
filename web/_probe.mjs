// 临时探针：复刻前端 sse.ts 的解析逻辑，分别直连 8080 与经 5173 代理，
// 对比 delta 内容是否存在逐 chunk 重复。
const BASE = process.argv[2] ?? 'http://127.0.0.1:8080'

async function login() {
  const u = 'probe_' + Date.now()
  await fetch(`${BASE}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'password123' }),
  }).catch(() => {})
  const r = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'password123' }),
  })
  const j = await r.json()
  return j.access_token
}

function parseSSE(text) {
  const events = []
  let currentEvent = 'message'
  let dataLines = []
  const flush = () => {
    if (dataLines.length > 0) events.push({ event: currentEvent, data: dataLines.join('\n') })
    currentEvent = 'message'
    dataLines = []
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') { flush(); continue }
    if (line.startsWith('event:')) currentEvent = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  flush()
  return events
}

async function main() {
  const token = await login()
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ content: '请出 2 道一元二次方程的练习题', mode: 'practice' }),
  })
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deltas = []
  let events = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const ev of parseSSE(chunk)) {
        events++
        if (ev.event === 'delta') deltas.push(JSON.parse(ev.data).text ?? '')
      }
    }
  }
  if (buffer.trim()) {
    for (const ev of parseSSE(buffer)) {
      events++
      if (ev.event === 'delta') deltas.push(JSON.parse(ev.data).text ?? '')
    }
  }
  // 重复检测：相邻两个 delta 完全相同时视为疑似重复块
  let dupChunks = 0
  for (let i = 1; i < deltas.length; i++) {
    if (deltas[i] === deltas[i - 1]) dupChunks++
  }
  const full = deltas.join('')
  console.log(`[${BASE}] total events=${events} delta_chunks=${deltas.length} 疑似相邻重复chunk=${dupChunks}`)
  console.log('  文本预览:', full.slice(0, 120).replace(/\n/g, '⏎'))
  // 每字符双写检测
  let doubled = 0
  for (let i = 1; i < full.length - 1; i++) if (full[i] === full[i - 1]) doubled++
  console.log(`  相邻重复字符数=${doubled} / 总长=${full.length}`)
}

main().catch((e) => { console.error('ERR', e); process.exit(1) })
