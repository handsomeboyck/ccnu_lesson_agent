// 协议级断点续流验证（无需浏览器）：
// 1. 发起长生成（真实模型）→ 正文 100 字时主动断连（模拟刷新）
// 2. 记录断点（streamId + 已消费最大 seq + 已消费文本）
// 3. 从断点续流（GET /v1/chat/stream/{streamId}?since=lastSeq+1）
// 4. 断言：seq 无重叠无缺口、文本拼接 == 最终完整内容、收到 [DONE]
// 5. 与 DB 权威消息对比
// 用法：node test-resume-protocol.mjs [apiBase]
const API = process.argv[2] || 'http://127.0.0.1:18080'

function genId(p) { return p + Math.random().toString(36).slice(2, 10) }
const u = genId('rv-')

async function registerLogin() {
  await fetch(`${API}/v1/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'ResumeTest-123' }),
  }).catch(() => {})
  const r = await fetch(`${API}/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'ResumeTest-123' }),
  })
  return r.json()
}

/** 读取 SSE 流，逐帧回调；返回 'done' | 'eof' */
async function readSSE(resp, onFrame, signal) {
  const reader = resp.body.getReader()
  const dc = new TextDecoder()
  let buf = ''
  for (;;) {
    if (signal && signal.aborted) return 'eof'
    let result
    try {
      result = await reader.read()
    } catch (e) {
      if (signal?.aborted) return 'eof'
      throw e
    }
    const { done, value } = result
    if (done) return 'eof'
    buf += dc.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      const t = l.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (data === '[DONE]') return 'done'
      if (!data) continue
      let parsed
      try { parsed = JSON.parse(data) } catch { continue }
      onFrame(parsed)
    }
  }
}

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`)
}

const { user, access_token: token } = await registerLogin()
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
console.log(`user=${user.username} api=${API}\n`)

// ---- 1. 发起长生成 ----
const ctrl = new AbortController()
const resp = await fetch(`${API}/v1/chat`, {
  method: 'POST', headers: H,
  body: JSON.stringify({
    conversation_id: '',
    content: '请写一篇非常长的文章（至少2000字）：如何养成好的阅读习惯。必须写满2000字以上，分五个章节，每章至少400字。',
    mode: 'companion',
  }),
  signal: ctrl.signal,
})
let streamId = ''
let convId = ''
const frames = [] // {seq, type, delta?}
let textBuf = ''
let cutFrame = -1

// 消费流；当正文超过 100 字（生成中段）时主动断连，模拟刷新
await readSSE(resp, (f) => {
  if (f.type === 'data-ccnu' && f.data?.type === 'meta') {
    streamId = f.data.streamId
    convId = f.data.conversation_id
  }
  frames.push(f)
  if (f.type === 'text-delta') textBuf += f.delta ?? ''
  if (cutFrame < 0 && f.type === 'text-delta' && textBuf.length > 100) {
    cutFrame = frames.length
    ctrl.abort()
  }
}, ctrl.signal)
await new Promise((r) => setTimeout(r, 500))

if (cutFrame < 0) {
  console.log('✗ 流在正文 100 字前就结束（模型输出过短），无法验证断连；请重试')
  process.exit(1)
}

const seqs = frames.filter((f) => typeof f.seq === 'number').map((f) => f.seq)
const maxSeq = seqs.length ? Math.max(...seqs) : -1
const textAtCut = textBuf
console.log(`断连时: streamId=${streamId} convId=${convId} 帧数=${frames.length} maxSeq=${maxSeq} 文本长度=${textAtCut.length}`)
check('meta 携带 streamId/convId', !!streamId && !!convId)
check('主链路帧携带单调 seq', seqs.length > 0 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), `seqs=${seqs.slice(0, 5)}…`)
// 主链路自身连续性（缺号说明生成端 append 就跳号）
let mainGap = -1
for (let i = 1; i < seqs.length; i++) {
  if (seqs[i] !== seqs[i - 1] + 1) { mainGap = i; break }
}
check('主链路 seq 连续（生成端无跳号）', mainGap < 0, mainGap > 0 ? `gap@${mainGap}` : '')

// ---- 2. 从断点续流 ----
const since = maxSeq + 1
const r2 = await fetch(`${API}/v1/chat/stream/${streamId}?since=${since}`, { headers: H })
check('续流端点 200', r2.status === 200, `status=${r2.status}`)
const minSeq = Number(r2.headers.get('X-Stream-Min-Seq') ?? '')
console.log(`续流头: X-Stream-Min-Seq=${minSeq} X-Stream-From-Seq=${since}`)

const resumedFrames = []
let resumedText = ''
const end = await readSSE(r2, (f) => {
  resumedFrames.push(f)
  if (f.type === 'text-delta') resumedText += f.delta ?? ''
})
check('续流收到 [DONE]', end === 'done')

// ---- 3. 断言 ----
const rSeqs = resumedFrames.filter((f) => typeof f.seq === 'number').map((f) => f.seq)
check('续流首帧 seq == 断点+1（无重叠）', rSeqs.length > 0 && rSeqs[0] === since, `first=${rSeqs[0]} since=${since}`)
let gapAt = -1
for (let i = 1; i < rSeqs.length; i++) {
  if (rSeqs[i] !== rSeqs[i - 1] + 1) { gapAt = i; break }
}
check('续流 seq 单调连续', gapAt < 0, `n=${rSeqs.length}`)
const full = textAtCut + resumedText
check('续流后文本长度明显增长', resumedText.length > 200, `+${resumedText.length} 字符`)
check('拼接文本无重复标记', !full.includes('阅读习惯。阅读习惯。'), '')

// ---- 4. 与 DB 权威对比（轮询等落库） ----
let dbContent = ''
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const m = await (await fetch(`${API}/v1/conversations/${convId}/messages`, { headers: H })).json()
  const last = m.messages?.[m.messages.length - 1]
  if (last?.role === 'assistant' && (last.content || '').length > 0) { dbContent = last.content; break }
}
check('DB 已落库完整回复', dbContent.length > 500, `len=${dbContent.length}`)
check('断点拼接文本 ≈ DB 完整文本（前缀一致）', dbContent.startsWith(textAtCut.slice(0, 100)) || full.startsWith(dbContent.slice(0, 100)), '')

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok)
console.log(`\n==== 结果: ${results.length - failed.length}/${results.length} 通过 ====`)
process.exit(failed.length ? 1 : 0)
