// streamMerge 纯函数单测（Node 24 直接跑 TS：type stripping）
// 验证自研 chunk→parts 合并器与后端帧词汇表配合正确。
import { applyChunk } from './src/lib/streamMerge.ts'

let pass = 0
let fail = 0
function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`✓ ${name}`) }
  else { fail++; console.log(`✗ ${name}\n  got: ${a}\n  exp: ${e}`) }
}

// 1. reasoning 三件套
let p = []
p = applyChunk(p, { type: 'reasoning-start', id: 'r1' })
p = applyChunk(p, { type: 'reasoning-delta', id: 'r1', delta: '先分析' })
p = applyChunk(p, { type: 'reasoning-delta', id: 'r1', delta: '题目条件' })
p = applyChunk(p, { type: 'reasoning-end', id: 'r1' })
eq('reasoning 合并', p, [{ type: 'reasoning', id: 'r1', text: '先分析题目条件', state: 'done' }])

// 2. text 拼接 + 未知帧忽略
p = []
p = applyChunk(p, { type: 'start', messageId: 'm1' }) // 未知帧忽略
p = applyChunk(p, { type: 'text-start', id: 'text' })
p = applyChunk(p, { type: 'text-delta', id: 'text', delta: '一元二次' })
p = applyChunk(p, { type: 'text-delta', id: 'text', delta: '方程' })
p = applyChunk(p, { type: 'finish', finishReason: 'stop' }) // 忽略
eq('text 合并', p, [{ type: 'text', text: '一元二次方程' }])

// 3. 工具卡状态机
p = []
p = applyChunk(p, { type: 'tool-input-start', toolCallId: 't1', toolName: 'quiz_generator' })
p = applyChunk(p, { type: 'tool-input-delta', toolCallId: 't1', inputTextDelta: '{"topic":' })
p = applyChunk(p, { type: 'tool-input-delta', toolCallId: 't1', inputTextDelta: '"方程"}' })
eq('tool 参数流式累积', p, [{ type: 'tool-quiz_generator', toolCallId: 't1', state: 'input-streaming', inputTextDelta: '{"topic":"方程"}' }])
p = applyChunk(p, { type: 'tool-input-available', toolCallId: 't1', toolName: 'quiz_generator', input: { topic: '方程' } })
p = applyChunk(p, { type: 'tool-output-available', toolCallId: 't1', output: { summary: '已生成 5 题' } })
eq('tool 完成态', p, [
  { type: 'tool-quiz_generator', toolCallId: 't1', state: 'output-available', input: { topic: '方程' }, providerExecuted: true, output: { summary: '已生成 5 题' } },
])

// 4. data-ccnu（ask / artifacts / meta 由上层处理，不进 parts 的除外）
p = []
p = applyChunk(p, { type: 'data-ccnu', data: { type: 'ask', question: '要几道题？', options: ['5', '10'] } })
eq('data-ccnu ask', p, [{ type: 'data-ccnu', data: { type: 'ask', question: '要几道题？', options: ['5', '10'] } }])

// 5. 续流去重场景：seq 字段剥离（上层已去重，这里验证 seq 不污染 parts）
p = []
p = applyChunk(p, { type: 'text-delta', id: 'text', delta: 'a', seq: 10 })
p = applyChunk(p, { type: 'text-delta', id: 'text', delta: 'b', seq: 11 })
eq('seq 字段不进入 parts', p, [{ type: 'text', text: 'ab' }])

// 6. 续流中途接入（已有 text part，收到 text-start 不重复创建）
p = [{ type: 'text', text: '已生成部分' }]
p = applyChunk(p, { type: 'text-start', id: 'text' })
p = applyChunk(p, { type: 'text-delta', id: 'text', delta: '继续' })
eq('续流 text 追加', p, [{ type: 'text', text: '已生成部分继续' }])

// 7. 续流中途接入工具（已有 input-streaming part，收到 delta 继续拼）
p = [{ type: 'tool-quiz_generator', toolCallId: 't1', state: 'input-streaming', inputTextDelta: '{"a":' }]
p = applyChunk(p, { type: 'tool-input-delta', toolCallId: 't1', inputTextDelta: '1}' })
eq('续流 tool 参数续拼', p, [{ type: 'tool-quiz_generator', toolCallId: 't1', state: 'input-streaming', inputTextDelta: '{"a":1}' }])

// 8. reasoning 续流中途接入
p = [{ type: 'reasoning', id: 'r1', text: '已想', state: 'streaming' }]
p = applyChunk(p, { type: 'reasoning-delta', id: 'r1', delta: '了半' })
p = applyChunk(p, { type: 'reasoning-end', id: 'r1' })
eq('续流 reasoning 续拼', p, [{ type: 'reasoning', id: 'r1', text: '已想了半', state: 'done' }])

console.log(`\n==== streamMerge: ${pass}/${pass + fail} 通过 ====`)
process.exit(fail ? 1 : 0)
