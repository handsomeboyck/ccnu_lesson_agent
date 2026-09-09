// 文件 × 技能矩阵测试：解析成功率 + 技能调用耗时/成功率
import fs from 'fs'

const API = 'https://www.ccnu.chat'
const DIR = 'C:/Users/wps/software/work/dsh_workplace/agent/'

const u = 'fmtx-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) }).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: 'SpikeTest-123' }) })
const { access_token: token } = await lr.json()
const H = { Authorization: `Bearer ${token}` }

async function uploadLibrary(fn) {
  const fd = new FormData()
  fd.append('file', new Blob([fs.readFileSync(DIR + fn)]), fn)
  const t0 = Date.now()
  const r = await fetch(`${API}/v1/library/files`, { method: 'POST', headers: H, body: fd })
  if (r.status !== 201) return { fn, lib: `上传失败 HTTP ${r.status}` }
  const { id } = await r.json()
  // 轮询状态
  for (let i = 0; i < 20; i++) {
    await new Promise((r2) => setTimeout(r2, 500))
    const list = await fetch(`${API}/v1/library/files`, { headers: H }).then((x) => x.json())
    const f = (list.files ?? []).find((x) => x.id === id)
    if (f && f.status !== 'parsing') return { fn, lib: `parse ${f.status} in ${((Date.now() - t0) / 1000).toFixed(1)}s` }
  }
  return { fn, lib: '超时(parsing)' }
}

async function chatWithFile(fn, prompt) {
  const fd = new FormData()
  fd.append('files', new Blob([fs.readFileSync(DIR + fn)]), fn)
  const up = await fetch(`${API}/v1/chat/attachments`, { method: 'POST', headers: H, body: fd })
  const { results } = await up.json()
  const docId = results?.[0]?.doc_id
  const t0 = Date.now()
  let firstText = -1, finishAt = -1, err = null, len = 0, text = ''
  const resp = await fetch(`${API}/v1/chat`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversation_id: '', content: prompt, attachments: docId ? [docId] : [] }),
  })
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      if (!l.startsWith('data: ')) continue
      const d = l.slice(6).trim()
      if (d === '[DONE]') break
      let c
      try { c = JSON.parse(d) } catch { continue }
      const now = Date.now() - t0
      if (c.type === 'text-delta') { if (firstText < 0) firstText = now; len += (c.delta ?? '').length; text += c.delta ?? '' }
      if (c.type === 'finish') finishAt = now
      if (c.type === 'error') err = c.error ?? c.message ?? 'stream error'
    }
  }
  const dur = finishAt >= 0 ? finishAt : Date.now() - t0
  return { firstText: (firstText / 1000).toFixed(1) + 's', dur: (dur / 1000).toFixed(1) + 's', len, ok: !err && len > 0, err, hasReport: text.includes('评估') || text.includes('平均') || text.includes('排名') || text.includes('诊断') || text.includes('问题') }
}

const cases = [
  { fn: 'jiaoan.docx', prompt: '请用 /evaluate 评估这份教案，给出打分和改进建议', skill: 'evaluate_design' },
  { fn: '教案.doc', prompt: '请用 /diagnose 诊断这份教案，找出主要问题', skill: 'diagnose_plan' },
  { fn: '教案.pdf', prompt: '请用 /diagnose 诊断这份教案，找出主要问题', skill: 'diagnose_plan' },
  { fn: '教案.txt', prompt: '请用 /evaluate 评估这份教案，给出打分', skill: 'evaluate_design' },
  { fn: '教案.md', prompt: '请根据我上传的资料回答：这份教学设计有几个环节？', skill: 'knowledge_retrieve' },
  { fn: '成绩.csv', prompt: '用 Python 分析我上传的成绩表，统计每科平均分并按总分排名', skill: 'execute_code' },
  { fn: '成绩.xlsx', prompt: '用 Python 分析我上传的成绩表，统计每科平均分并按总分排名', skill: 'execute_code' },
  { fn: '成绩.xls', prompt: '用 Python 分析我上传的成绩表，统计每科平均分并按总分排名', skill: 'execute_code' },
]

console.log('==== 文件 × 技能矩阵（生产实测）====')
for (const c of cases) {
  const lib = await uploadLibrary(c.fn)
  const r = await chatWithFile(c.fn, c.prompt)
  const pass = lib.lib.startsWith('parse ready') && r.ok ? '✓' : '✗'
  console.log(`${pass} ${c.fn.padEnd(12)} [${c.skill}] 资料库:${lib.lib} | 聊天 首字:${r.firstText} 总时长:${r.dur} 文本:${r.len}字 含要点:${r.hasReport ? '✓' : '✗'} ${r.err ? 'ERR:' + String(r.err).slice(0, 80) : ''}`)
}
