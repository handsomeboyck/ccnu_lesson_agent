// SSE 对话客户端：POST /v1/chat，用 fetch ReadableStream 解析命名事件流。
// 事件协议见 Agent.md §6：meta → delta* → done | error（tool_call/tool_result M1 起）。
import type { SSEEvent } from '../types'

const BASE = import.meta.env.VITE_API_BASE ?? ''

export interface ChatStreamParams {
  conversationId?: string
  content: string
  mode?: string
  courseId?: string
  attachments?: string[] // 资料库文档 id（消息级附件）
  token: string
  signal: AbortSignal
  onEvent: (ev: SSEEvent) => void
}

/** 解析 SSE 文本为事件序列（event:/data: 行 + 空行分隔）。 */
export function parseSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  let currentEvent = 'message'
  let dataLines: string[] = []

  const flush = () => {
    if (dataLines.length > 0) {
      events.push({ event: currentEvent, data: dataLines.join('\n') })
    }
    currentEvent = 'message'
    dataLines = []
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  flush()
  return events
}

export async function streamChat(params: ChatStreamParams): Promise<void> {
  const res = await fetch(`${BASE}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({
      conversation_id: params.conversationId ?? '',
      content: params.content,
      mode: params.mode ?? 'companion',
      course_id: params.courseId ?? '',
      attachments: params.attachments ?? [],
    }),
    signal: params.signal,
  })

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch {
      // ignore
    }
    throw new Error(msg)
  }
  if (!res.body) throw new Error('response has no body')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // 按空行切分完整事件，保留尾部未完成部分
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const ev of parseSSE(chunk)) params.onEvent(ev)
    }
  }
  // 尾部残余
  if (buffer.trim()) {
    for (const ev of parseSSE(buffer)) params.onEvent(ev)
  }
}
