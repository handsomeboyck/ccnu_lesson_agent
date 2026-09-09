// 端到端：生成期间客户端断开（模拟刷新/切走）→ 后台继续 → 完整落库
const API = process.env.API || 'http://127.0.0.1:8080'
const u = 'bg-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { access_token: t } = await lr.json()
const h = { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }

// 1) 发起长对话，读几秒后主动断开（模拟刷新）
const ac = new AbortController()
const r = await fetch(`${API}/v1/chat`, {
  method: 'POST', headers: h, signal: ac.signal,
  body: JSON.stringify({ conversation_id: '', content: '详细讲解一下牛顿三大定律，每个定律举两个生活中的例子，写长一点' }),
})
const rd = r.body.getReader()
const dc = new TextDecoder()
try {
  for (let i = 0; i < 6; i++) {
    const { done, value } = await rd.read()
    if (done) break
    dc.decode(value, { stream: true })
  }
} catch {}

// 2) 断开前查 generating
const gen1 = await (await fetch(`${API}/v1/chat/generating`, { headers: h })).json()
console.log('断开时 generating 数:', gen1.generating.length)
const convId = gen1.generating[0]?.conversation_id || ''
console.log('会话ID:', convId.slice(0, 10))

// 3) 主动断开（模拟刷新/切走）
ac.abort()
await new Promise((r2) => setTimeout(r2, 4000))

// 4) 生成应仍在后台继续
const gen2 = await (await fetch(`${API}/v1/chat/generating`, { headers: h })).json()
console.log('断开4s后生成仍在后台:', gen2.generating.length > 0 ? '✓' : '✗')

// 5) 等生成完成
let wait = 0
while (wait < 90000) {
  const g = await (await fetch(`${API}/v1/chat/generating`, { headers: h })).json()
  if (g.generating.length === 0) break
  await new Promise((r2) => setTimeout(r2, 3000))
  wait += 3000
}
console.log('后台生成完成（等待', wait / 1000, 's）')

// 6) 验证消息完整落库
if (convId) {
  const msgs = await (await fetch(`${API}/v1/conversations/${convId}/messages`, { headers: h })).json()
  const last = msgs.messages[msgs.messages.length - 1]
  const len = (last?.content || '').length
  console.log('最后消息 role:', last?.role, '| 长度:', len, last?.role === 'assistant' && len > 100 ? '✓ 完整落库' : '✗')
}
