// 缓存命中率实测：同技能连发两次 + 同一会话连问两轮，观察 cache_hit/miss
const API = 'https://www.ccnu.chat'

const u = 'ch-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { access_token: token } = await lr.json()

async function chat(content, convId = '') {
  const resp = await fetch(`${API}/v1/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: convId, content }),
  })
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = '', done2 = false
  let conv = convId
  while (!done2) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue
      const d = l.slice(6).trim()
      if (d === '[DONE]') { done2 = true; break }
      let c
      try { c = JSON.parse(d) } catch { continue }
      if (c.type === 'data-ccnu' && c.data?.type === 'meta' && typeof c.data.conversation_id === 'string') conv = c.data.conversation_id
    }
  }
  return conv
}

console.log('==== 同技能连发两次（观察 skill-stream 缓存）====')
const c1 = await chat('讲解一下牛顿第一定律')
const c2 = await chat('讲解一下牛顿第一定律')
console.log('--- 第二个用户第二次同技能 ---')
const u2 = 'ch2-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u2, password: 'SpikeTest-123' }) }).catch(() => {})
const lr2 = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u2, password: 'SpikeTest-123' }) })
const t2 = (await lr2.json()).access_token
await fetch(`${API}/v1/chat`, { method: 'POST', headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ conversation_id: '', content: '讲解一下牛顿第一定律' }) }).then((r) => r.body?.cancel())

console.log('==== 同一会话连问两轮（观察 agent-round 历史前缀缓存）====')
const conv = await chat('你好，简单介绍一下一元二次方程')
await chat('那它的求根公式是什么？请讲解', conv)
console.log('==== 完成，读取 [llm] 日志见 cache_hit/cache_miss ====')
