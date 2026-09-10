// 前端引擎逻辑的协议级验证（复刻 useChatStream.handleFrame + resume 的数据流）：
//   1. 发送 → 消费帧：meta 写入 streamIdRef；普通帧 seq 去重 + parts 合并 + 节流持久化
//   2. 中断（模拟刷新）→ loadResume 断言 state.streamId 非空（问题1修复验证）
//   3. 用 state 续流：fetch since=lastSeq+1 → seq 去重续拼 → [DONE]
//   4. 与 DB 权威消息对比
// 用法：node test-resume-frontend-logic.mjs [apiBase]
import { applyChunk } from './src/lib/streamMerge.ts'

const API = process.argv[2] || 'http://127.0.0.1:18080'
const SAVE_INTERVAL = 300

function genId(p) { return p + Math.random().toString(36).slice(2, 10) }
const u = genId('fl-')
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'ResumeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'ResumeTest-123' }) })
const { access_token: token } = await lr.json()
const H = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }

const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`) }

// ---- 模拟前端状态（与 hook 的 useRef 语义一致：{current} 对象）----
const streamIdRef = { current: '' } // meta 帧写入（问题 1 修复点）
const convIdRef = { current: '' }
const lastSeqRef = { current: -1 }
const partsRef = { current: [] }
let lastSave = 0
let resumeState = null // localStorage 模拟

function saveResume(s) { resumeState = s }
function handleFrame(chunk) {
  const seq = typeof chunk.seq === 'number' ? chunk.seq : undefined
  if (seq !== undefined) {
    if (seq <= lastSeqRef.current) return // seq 去重
    lastSeqRef.current = seq
  }
  if (chunk.type === 'data-ccnu' && chunk.data?.type === 'meta') {
    if (typeof chunk.data.conversation_id === 'string' && typeof chunk.data.streamId === 'string') {
      convIdRef.current = chunk.data.conversation_id
      streamIdRef.current = chunk.data.streamId
    }
    return
  }
  if (chunk.type === 'data-ccnu' && chunk.data?.type === 'done') return
  if (seq !== undefined && 'seq' in chunk) {
    const { seq: _seq, ...rest } = chunk
    partsRef.current = applyChunk(partsRef.current, rest)
  } else {
    partsRef.current = applyChunk(partsRef.current, chunk)
  }
  const now = Date.now()
  if (now - lastSave >= SAVE_INTERVAL) {
    lastSave = now
    saveResume({ convId: convIdRef.current, streamId: streamIdRef.current, lastSeq: lastSeqRef.current, parts: partsRef.current, updatedAt: now })
  }
}

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

// ---- 1. 发送并消费（模拟 handleFrame）----
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
let textAtCut = ''
let seenFrames = 0
await readSSE(resp, (f) => {
  seenFrames++
  handleFrame(f)
  if (f.type === 'text-delta') textAtCut += f.delta ?? ''
  if (f.type === 'text-delta' && textAtCut.length > 100) ctrl.abort() // 生成中段断连
}, ctrl.signal)
await new Promise((r) => setTimeout(r, 400))
if (seenFrames === 0) {
  console.log('✗ 未收到任何帧（resp.status=' + resp.status + '），无法验证')
  process.exit(1)
}

console.log(`断连: conv=${convIdRef.current} streamId=${streamIdRef.current || '(空!)'} lastSeq=${lastSeqRef.current} parts=${partsRef.current.length} 文本=${textAtCut.length} 字`)

// ---- 2. 问题 1 修复验证：resume state 的 streamId 必须非空 ----
check('断点状态 streamId 非空（问题1修复）', resumeState !== null && typeof resumeState.streamId === 'string' && resumeState.streamId.length > 0, `streamId=${resumeState?.streamId?.slice(0, 8)}…`)
check('断点状态 convId 正确', resumeState?.convId === convIdRef.current, '')
check('断点状态 lastSeq 不超前（持久化节流 ≤ 已消费）', resumeState?.lastSeq <= lastSeqRef.current, `state=${resumeState?.lastSeq} ref=${lastSeqRef.current}`)

// ---- 3. 用 state 续流（复刻 resume()）----
const since = resumeState.lastSeq + 1
const r2 = await fetch(`${API}/v1/chat/stream/${resumeState.streamId}?since=${since}`, { headers: H })
check('续流端点 200', r2.status === 200, `status=${r2.status}`)
const minSeq = Number(r2.headers.get('X-Stream-Min-Seq') ?? '')
check('无 gap（since >= minSeq）', !Number.isNaN(minSeq) && since >= minSeq, `minSeq=${minSeq} since=${since}`)

// 续流消费：seq 去重 + 续拼 parts（复用同一 handleFrame，但 lastSeq 从 state 恢复）
lastSeqRef.current = resumeState.lastSeq
partsRef.current = resumeState.parts
const resumedText = []
await readSSE(r2, (f) => {
  handleFrame(f)
  if (f.type === 'text-delta') resumedText.push(f.delta ?? '')
})
const finalText = partsRef.current.filter((p) => p.type === 'text').map((p) => p.text).join('')
console.log(`续流完成: lastSeq=${lastSeqRef.current} parts=${partsRef.current.length} 最终文本=${finalText.length} 字`)

// ---- 4. 断言 ----
check('续流后 parts 含完整文本', finalText.length > 1000, `len=${finalText.length}`)
check('文本无重复（无 "阅读习惯。阅读习惯。"）', !finalText.includes('阅读习惯。阅读习惯。'), '')
check('断连前文本是最终文本前缀', finalText.startsWith(textAtCut.slice(0, 60)), '')

// 与 DB 对比
let dbContent = ''
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const m = await (await fetch(`${API}/v1/conversations/${convIdRef.current}/messages`, { headers: H })).json()
  const last = m.messages?.[m.messages.length - 1]
  if (last?.role === 'assistant' && (last.content || '').length > 0) { dbContent = last.content; break }
}
check('DB 已落库', dbContent.length > 1000, `len=${dbContent.length}`)
check('续流拼接 ≈ DB（前缀一致）', dbContent.startsWith(textAtCut.slice(0, 60)) || finalText.startsWith(dbContent.slice(0, 60)), '')

const failed = results.filter((r) => !r.ok)
console.log(`\n==== 结果: ${results.length - failed.length}/${results.length} 通过 ====`)
process.exit(failed.length ? 1 : 0)
