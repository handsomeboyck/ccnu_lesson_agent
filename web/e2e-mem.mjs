// 触发一个典型 execute_code 任务并保持运行 ~60s（供外部采样内存）
const API = 'https://www.ccnu.chat'
const u = 'mem-' + Math.random().toString(36).slice(2, 8)
await fetch(`${API}/v1/auth/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
}).catch(() => {})
const lr = await fetch(`${API}/v1/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
})
const { access_token: token } = await lr.json()
const r = await fetch(`${API}/v1/chat`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    conversation_id: '',
    content:
      '用 Python 做班级成绩分析：构造 40 名学生 5 科成绩数据，pandas 统计（每科平均分/总分排名），matplotlib 画柱状图+散点图保存 png，然后 time.sleep(40) 保持进程存活',
  }),
})
const rd = r.body.getReader()
const dc = new TextDecoder()
let buf = ''
try {
  while (true) {
    const { done, value } = await rd.read()
    if (done) break
    buf += dc.decode(value, { stream: true })
  }
} catch {}
console.log('task done, bytes:', buf.length)
