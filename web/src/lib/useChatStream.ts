// 自研流式聊天引擎：统一处理「正常发送 / 断点续流 / 权威兜底重建」。
//
// 为什么绕开 AI SDK useChat：真续流需要逐帧访问（含 seq 去重），
// 而 SDK 内部用 z.looseObject 解析 chunk 会剥离未知字段（seq 拿不到），
// 且 parts 状态机不支持半路接管一条进行中的流。因此自研一个薄引擎：
//   - sendMessage：POST /v1/chat，消费 SSE 帧（chunk 自带 seq），applyChunk 合并 parts；
//   - resume：刷新后从 localStorage 恢复断点状态，重放端点 since=lastSeq+1 续流；
//   - 兜底：续流失败/流过期 → 由上层走 listGenerating + 轮询 DB 权威重建。
// 渲染层（MessageRow / 卡片组件）与历史回看（historyToMessages）完全复用。
import { useCallback, useEffect, useRef, useState } from 'react'
import { applyChunk, type CcnnPart } from './streamMerge'
import { saveResume, loadResume, type StreamResumeState } from './useStreamResume'
import { useAuth } from '../store/auth'

export type ChatStatus = 'ready' | 'streaming' | 'error'

export interface ChatStreamMessage {
  id: string
  role: 'user' | 'assistant'
  parts: CcnnPart[]
}

export interface ChatStreamOptions {
  /** meta 帧到达（会话 id + streamId 回传，供上层刷新会话列表/持久化 streamMap） */
  onMeta: (info: { conversationId: string; streamId: string }) => void
  /** [DONE] 后回调（上层据此从 DB 权威重建消息列表） */
  onDone: (convId: string) => void
}

const RENDER_INTERVAL = 80 // setMessages 节流（ms）
const SAVE_INTERVAL = 300 // resume state 持久化节流（ms）：刷新最多丢 300ms 增量，续流由缓冲补齐

/** 解析 SSE 帧流（data: {json} 行）。返回 'done'（收到 [DONE]）或 'eof'（连接结束）。 */
async function consumeSSE(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onChunk: (chunk: Record<string, any>) => void,
  signal: AbortSignal,
): Promise<'done' | 'eof'> {
  const dc = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return 'eof'
    buf += dc.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const l of lines) {
      const t = l.trim()
      if (!t.startsWith('data:')) continue
      const data = t.slice(5).trim()
      if (data === '[DONE]') return 'done'
      if (data === '') continue
      try {
        onChunk(JSON.parse(data))
      } catch {
        // 忽略无法解析的帧
      }
    }
    if (signal.aborted) return 'eof'
  }
}

export function useChatStream(opts: ChatStreamOptions) {
  const [messages, setMessagesState] = useState<ChatStreamMessage[]>([])
  const [status, setStatus] = useState<ChatStatus>('ready')
  const [error, setError] = useState<string>('')
  const [bgGenerating, setBgGenerating] = useState(false) // 「正在后台生成中」提示（刷新恢复/兜底）

  const abortRef = useRef<AbortController | null>(null)
  const partsRef = useRef<CcnnPart[]>([])
  const lastSeqRef = useRef(-1)
  const lastSaveRef = useRef(0)
  const lastRenderRef = useRef(0)
  const pendingMsgIdRef = useRef('')
  const convIdRef = useRef('')
  const streamIdRef = useRef('') // 当前流的 streamId（meta 帧写入；断点状态持久化用）
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flushRenderRef = useRef<(() => void) | null>(null)
  const onMetaRef = useRef(opts.onMeta)
  const onDoneRef = useRef(opts.onDone)
  onMetaRef.current = opts.onMeta
  onDoneRef.current = opts.onDone

  useEffect(
    () => () => {
      abortRef.current?.abort()
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    },
    [],
  )

  const setMessages = useCallback((m: ChatStreamMessage[]) => setMessagesState(m), [])

  // ---- 渲染节流：把 partsRef 的最新快照同步到 messages 最后一条 assistant 消息 ----
  const scheduleRender = useCallback(() => {
    const now = Date.now()
    if (now - lastRenderRef.current >= RENDER_INTERVAL) {
      lastRenderRef.current = now
      flushRenderRef.current?.()
    } else if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null
        lastRenderRef.current = Date.now()
        flushRenderRef.current?.()
      }, RENDER_INTERVAL - (now - lastRenderRef.current))
    }
  }, [])

  const flushRender = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    flushRenderRef.current?.()
    flushRenderRef.current = null
  }, [])

  // 帧处理（发送与续流共用）：seq 去重 → applyChunk → 节流渲染 → 节流持久化断点
  const handleFrame = useCallback(
    (chunk: Record<string, any>) => {
      const seq = typeof chunk.seq === 'number' ? chunk.seq : undefined
      if (seq !== undefined) {
        if (seq <= lastSeqRef.current) return // 重复帧（持久化落后/重放重叠）跳过
        lastSeqRef.current = seq
      }
      // meta 帧：会话 id + streamId 回传（streamMap 持久化由上层处理）
      if (chunk.type === 'data-ccnu' && chunk.data?.type === 'meta') {
        if (typeof chunk.data.conversation_id === 'string' && typeof chunk.data.streamId === 'string') {
          convIdRef.current = chunk.data.conversation_id
          streamIdRef.current = chunk.data.streamId
          onMetaRef.current({ conversationId: chunk.data.conversation_id, streamId: chunk.data.streamId })
        }
        return // meta 不入 parts
      }
      // data-ccnu done：不重复入 parts（上层 onDone 处理 DB 重建）
      if (chunk.type === 'data-ccnu' && chunk.data?.type === 'done') return
      if (seq !== undefined && 'seq' in chunk) {
        const { seq: _seq, ...rest } = chunk
        partsRef.current = applyChunk(partsRef.current, rest)
      } else {
        partsRef.current = applyChunk(partsRef.current, chunk)
      }
      scheduleRender()
      const now = Date.now()
      if (now - lastSaveRef.current >= SAVE_INTERVAL) {
        lastSaveRef.current = now
        saveResume({
          convId: convIdRef.current,
          streamId: streamIdRef.current, // ★ 用 ref（普通帧不含 streamId 字段）
          lastSeq: lastSeqRef.current,
          parts: partsRef.current,
          updatedAt: now,
        } as StreamResumeState)
      }
    },
    [scheduleRender],
  )

  // 兜底重建：从 DB 拉权威消息（重试等落库完成）。
  const rebuildFromDB = useCallback(
    async (convId: string, listMessages: (cid: string) => Promise<any[]>, toMessages: (msgs: any[]) => ChatStreamMessage[]) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const msgs = await listMessages(convId)
          const last = msgs[msgs.length - 1]
          if (last && (last.role === 'assistant') && (last.content || last.ask)) {
            setMessages(toMessages(msgs))
            return
          }
        } catch {
          // 忽略单次失败，继续轮询
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    },
    [setMessages],
  )

  /** 发送一条新消息（流式）。text 为提交给模型的原文，displayText 为界面展示文本。 */
  const sendMessage = useCallback(
    async (input: {
      text: string
      displayText: string
      convId: string
      mode: string
      attachments: string[]
      listMessages: (cid: string) => Promise<any[]>
      toMessages: (msgs: any[]) => ChatStreamMessage[]
    }) => {
      if (status !== 'ready') return
      const userId = `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const userMsg: ChatStreamMessage = {
        id: userId,
        role: 'user',
        parts: [{ type: 'text', text: input.displayText }],
      }
      const placeholderId = `a-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      setMessagesState((prev) => [...prev, userMsg])
      pendingMsgIdRef.current = placeholderId
      partsRef.current = []
      lastSeqRef.current = -1
      lastSaveRef.current = 0
      lastRenderRef.current = Date.now() - RENDER_INTERVAL
      convIdRef.current = input.convId
      streamIdRef.current = '' // 新流：等 meta 帧回填
      // 注入渲染通道：parts 快照 → 最后一条 assistant 消息
      flushRenderRef.current = () => {
        setMessagesState((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && last.id === pendingMsgIdRef.current) {
            return [...prev.slice(0, -1), { ...last, parts: partsRef.current }]
          }
          return [...prev, { id: pendingMsgIdRef.current, role: 'assistant', parts: partsRef.current }]
        })
      }
      setStatus('streaming')
      setError('')
      const ctrl = new AbortController()
      abortRef.current = ctrl
      const token = useAuth.getState().accessToken
      try {
        const resp = await fetch('/v1/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token ?? ''}` },
          body: JSON.stringify({
            conversation_id: input.convId || undefined,
            content: input.text,
            mode: input.mode,
            attachments: input.attachments.length > 0 ? input.attachments : undefined,
          }),
          signal: ctrl.signal,
        })
        if (!resp.ok) {
          let msg = `HTTP ${resp.status}`
          try {
            const b = (await resp.json()) as { error?: string }
            if (b.error) msg = b.error
          } catch {
            /* ignore */
          }
          throw new Error(msg)
        }
        const reader = resp.body?.getReader()
        if (!reader) throw new Error('streaming unsupported')
        await consumeSSE(reader, handleFrame, ctrl.signal)
        flushRender()
        if (ctrl.signal.aborted) {
          // 切走/暂停（非手动断开）：保留断点状态，切回时仍可续流
          setStatus('ready')
          return
        }
        saveResume(null) // 流正常结束：清断点（已完成内容由 DB 权威重建）
        // 流结束（[DONE] 或连接关闭）：DB 权威重建（保证与落库一致）
        await rebuildFromDB(convIdRef.current, input.listMessages, input.toMessages)
        setStatus('ready')
        onDoneRef.current(convIdRef.current)
      } catch (e) {
        if (ctrl.signal.aborted) {
          setStatus('ready')
          return
        }
        setError(e instanceof Error ? e.message : '发送失败')
        setStatus('error')
        // 网络错误 ≠ 手动断开：保留断点状态，网络恢复后刷新/重试可续流
      } finally {
        abortRef.current = null
        flushRenderRef.current = null
      }
    },
    [handleFrame, rebuildFromDB, status],
  )

  /** 刷新后调用：从断点续流。返回 true 表示续流接管（含失败降级由上层兜底时返回 false）。 */
  const resume = useCallback(
    async (input: {
      convId: string
      listMessages: (cid: string) => Promise<any[]>
      toMessages: (msgs: any[]) => ChatStreamMessage[]
      /** 断点状态缺失时的兜底 streamId（meta 曾回传过该会话的流）→ 纯重放续流（since=0 重建） */
      fallbackStreamId?: string
    }): Promise<boolean> => {
      let state = loadResume()
      if (!state || state.convId !== input.convId) {
        // 断点状态缺失（如刷新过早/切走清空）：若有 streamId 则退化为纯重放续流
        if (!input.fallbackStreamId) return false
        state = { convId: input.convId, streamId: input.fallbackStreamId, lastSeq: -1, parts: [], updatedAt: 0 }
      }
      const token = useAuth.getState().accessToken
      if (!token) return false

      const since = state.lastSeq + 1
      const ctrl = new AbortController()
      abortRef.current = ctrl
      let resp: Response
      try {
        resp = await fetch(`/v1/chat/stream/${state.streamId}?since=${since}`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        })
      } catch {
        abortRef.current = null
        return false
      }
      if (resp.status === 404 || !resp.ok) {
        abortRef.current = null
        saveResume(null)
        return false
      }
      // gap 检测：头部被裁剪/覆盖 → 续不上，走权威兜底
      const minSeq = Number(resp.headers.get('X-Stream-Min-Seq') ?? '')
      if (!Number.isNaN(minSeq) && since < minSeq) {
        abortRef.current = null
        saveResume(null)
        return false
      }
      const reader = resp.body?.getReader()
      if (!reader) {
        abortRef.current = null
        saveResume(null)
        return false
      }

      // 接管：注入未完成消息（已生成部分立即展示），随后续流
      pendingMsgIdRef.current = `resume-${input.convId}`
      partsRef.current = state.parts
      lastSeqRef.current = state.lastSeq
      lastSaveRef.current = Date.now()
      lastRenderRef.current = Date.now() - RENDER_INTERVAL
      convIdRef.current = input.convId
      flushRenderRef.current = () => {
        setMessagesState((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && last.id === pendingMsgIdRef.current) {
            return [...prev.slice(0, -1), { ...last, parts: partsRef.current }]
          }
          return [...prev, { id: pendingMsgIdRef.current, role: 'assistant', parts: partsRef.current }]
        })
      }
      flushRenderRef.current() // 立即展示已生成部分
      setStatus('streaming')
      setError('')

      await consumeSSE(reader, handleFrame, ctrl.signal)
      flushRender()
      saveResume(null)
      setBgGenerating(false)
      if (ctrl.signal.aborted) {
        setStatus('ready')
        abortRef.current = null
        flushRenderRef.current = null
        return true
      }
      // 流结束：DB 权威重建
      await rebuildFromDB(input.convId, input.listMessages, input.toMessages)
      setStatus('ready')
      abortRef.current = null
      flushRenderRef.current = null
      onDoneRef.current(input.convId)
      return true
    },
    [handleFrame, rebuildFromDB],
  )

  /**
   * 停止本地流消费。
   * keepResume=true（切换会话）：仅 abort 本地 fetch，保留断点状态——切回时仍可续流（共识：切换 ≠ 断开）；
   * keepResume=false（手动停止）：清断点，由上层通知后端终止生成（唯一真正的"断开"）。
   */
  const stop = useCallback((keepResume = false) => {
    abortRef.current?.abort()
    abortRef.current = null
    if (!keepResume) saveResume(null)
    flushRender()
    setStatus('ready')
  }, [flushRender])

  return {
    messages,
    setMessages,
    status,
    error,
    bgGenerating,
    setBgGenerating,
    sendMessage,
    resume,
    stop,
  }
}
