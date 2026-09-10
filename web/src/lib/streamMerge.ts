// 流式 chunk → UIMessage parts 合并器（自研，供断点续流使用）。
// 与后端 POST /v1/chat 的 UI message stream v1 chunk 词汇表一一对应：
// start / meta / reasoning-start|delta|end / text-start|delta|end /
// tool-input-start|delta|available / tool-output-available / data-ccnu / finish / error / [DONE]
//
// 输出的 part 形状与 AI SDK UIMessage.parts 兼容，MessageRow / 卡片组件可原样复用。

export interface CcnnPart {
  type: string // 'text' | 'reasoning' | 'tool-<name>' | 'data-ccnu'
  id?: string
  text?: string
  state?: string // reasoning: streaming|done ; tool: input-streaming|input-available|output-available
  toolCallId?: string
  input?: unknown
  inputTextDelta?: string // 工具参数流式累积（input-available 前的半截参数）
  output?: { summary?: string }
  providerExecuted?: boolean
  data?: Record<string, unknown>
}

/** 应用一个 chunk 到 parts（不可变更新，返回新数组）。 */
export function applyChunk(parts: CcnnPart[], chunk: Record<string, any>): CcnnPart[] {
  switch (chunk.type) {
    case 'reasoning-start': {
      const idx = lastReasoningIdx(parts)
      if (idx >= 0) {
        // 续流时可能已有同一条 reasoning part，直接置为 streaming 续用
        const np = [...parts]
        np[idx] = { ...np[idx], state: 'streaming' }
        return np
      }
      return [...parts, { type: 'reasoning', id: chunk.id ?? 'r1', text: '', state: 'streaming' }]
    }
    case 'reasoning-delta': {
      const idx = lastReasoningIdx(parts)
      if (idx < 0) return parts // 防御：无 reasoning part 时丢弃（续流必有，正常不触发）
      const np = [...parts]
      np[idx] = { ...np[idx], text: (np[idx].text ?? '') + (chunk.delta ?? '') }
      return np
    }
    case 'reasoning-end': {
      const idx = lastReasoningIdx(parts)
      if (idx < 0) return parts
      const np = [...parts]
      np[idx] = { ...np[idx], state: 'done' }
      return np
    }
    case 'text-start': {
      const idx = parts.findIndex((p) => p.type === 'text')
      if (idx >= 0) return parts // 已有 text part（续流场景），不重复创建
      return [...parts, { type: 'text', text: '' }]
    }
    case 'text-delta': {
      const idx = lastTextIdx(parts)
      if (idx < 0) return [...parts, { type: 'text', text: chunk.delta ?? '' }] // 防御：续流起点恰好落在 text 中段
      const np = [...parts]
      np[idx] = { ...np[idx], text: (np[idx].text ?? '') + (chunk.delta ?? '') }
      return np
    }
    case 'text-end':
      return parts
    case 'tool-input-start': {
      const idx = findTool(parts, chunk.toolCallId)
      if (idx >= 0) return parts
      return [
        ...parts,
        { type: `tool-${chunk.toolName ?? ''}`, toolCallId: chunk.toolCallId, state: 'input-streaming', inputTextDelta: '' },
      ]
    }
    case 'tool-input-delta': {
      const idx = findTool(parts, chunk.toolCallId)
      if (idx < 0) return parts
      const np = [...parts]
      np[idx] = { ...np[idx], inputTextDelta: (np[idx].inputTextDelta ?? '') + (chunk.inputTextDelta ?? '') }
      return np
    }
    case 'tool-input-available': {
      const idx = findTool(parts, chunk.toolCallId)
      if (idx < 0) {
        return [
          ...parts,
          { type: `tool-${chunk.toolName ?? ''}`, toolCallId: chunk.toolCallId, state: 'input-available', input: chunk.input, providerExecuted: true },
        ]
      }
      const np = [...parts]
      // input 完整就绪后清除流式残留（inputTextDelta 仅 input-streaming 阶段使用）
      const { inputTextDelta: _itd, ...rest } = np[idx]
      np[idx] = { ...rest, state: 'input-available', input: chunk.input, providerExecuted: true }
      return np
    }
    case 'tool-output-available': {
      const idx = findTool(parts, chunk.toolCallId)
      if (idx < 0) return parts
      const np = [...parts]
      np[idx] = { ...np[idx], state: 'output-available', output: chunk.output, providerExecuted: true }
      return np
    }
    case 'data-ccnu':
      return [...parts, { type: 'data-ccnu', data: chunk.data }]
    default:
      // start / finish / error 等不进入 parts（由调用方另行处理）
      return parts
  }
}

function lastReasoningIdx(parts: CcnnPart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].type === 'reasoning') return i
  return -1
}

function lastTextIdx(parts: CcnnPart[]): number {
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].type === 'text') return i
  return -1
}

function findTool(parts: CcnnPart[], toolCallId: string): number {
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i]
    if (typeof p.type === 'string' && p.type.startsWith('tool-') && p.toolCallId === toolCallId) return i
  }
  return -1
}
