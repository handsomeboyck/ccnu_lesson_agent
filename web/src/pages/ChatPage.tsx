import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  deleteConversation,
  listConversations,
  listMessages,
  renameConversation,
  type ServerMessage,
} from '../api/client'
import { streamChat } from '../api/sse'
import { useAuth } from '../store/auth'
import { MODE_LABELS, type Conversation, type Mode, type SSEEvent } from '../types'

// 本地展示消息（含流式中占位）
interface DisplayMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
}

const WELCOME_SUGGESTIONS = [
  '用苏格拉底式提问帮我理解「导数」的概念',
  '生成 5 道一元二次方程练习题',
  '请讲解勾股定理的证明思路',
]

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** 服务端消息 → 展示消息（M0 仅 user/assistant，tool 消息忽略）。 */
function toDisplay(m: ServerMessage): DisplayMsg {
  return { id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content }
}

export default function ChatPage() {
  const user = useAuth((s) => s.user)
  const accessToken = useAuth((s) => s.accessToken)
  const clearAuth = useAuth((s) => s.clear)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMsg[]>([])
  const [draftMode, setDraftMode] = useState<Mode>('companion')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeConv = conversations.find((c) => c.id === activeId) ?? null

  // ---- 会话列表 ----
  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: list } = await listConversations()
      setConversations(list)
    } catch {
      // 静默（401 由拦截器处理）
    }
  }, [])

  useEffect(() => {
    void refreshConversations()
  }, [refreshConversations])

  // ---- 载入/切换会话 ----
  const openConversation = useCallback(
    async (id: string) => {
      abortRef.current?.abort()
      setActiveId(id)
      setError('')
      setSending(false)
      setMessages([])
      try {
        const { messages: msgs } = await listMessages(id)
        setMessages(msgs.map((m) => toDisplay(m)))
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载消息失败')
      }
    },
    [],
  )

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    setActiveId(null)
    setMessages([])
    setError('')
    setSending(false)
  }, [])

  // ---- 发送 ----
  async function handleSend(rawContent?: string) {
    const content = (rawContent ?? input).trim()
    if (!content || sending || !accessToken) return

    setInput('')
    setError('')
    setSending(true)

    // 无会话时新建用 draftMode；否则沿用会话自身模式
    const sendMode = activeConv ? activeConv.mode : draftMode

    const userMsg: DisplayMsg = { id: uid(), role: 'user', content }
    const botMsg: DisplayMsg = { id: uid(), role: 'assistant', content: '', pending: true }
    setMessages((prev) => [...prev, userMsg, botMsg])

    const controller = new AbortController()
    abortRef.current = controller
    let createdId: string | null = null

    const handleEvent = (ev: SSEEvent) => {
      try {
        if (ev.event === 'meta') {
          const data = JSON.parse(ev.data) as { conversation_id?: string }
          if (data.conversation_id) createdId = data.conversation_id
        } else if (ev.event === 'delta') {
          const data = JSON.parse(ev.data) as { text?: string }
          if (data.text) {
            setMessages((prev) => {
              const copy = [...prev]
              const last = copy[copy.length - 1]
              if (last && last.pending) last.content += data.text
              return copy
            })
          }
        } else if (ev.event === 'error') {
          const data = JSON.parse(ev.data) as { message?: string }
          setError(data.message ?? '生成出错')
        }
        // tool_call / tool_result：M1 Skill 可视化
      } catch {
        // 忽略无法解析的事件
      }
    }

    try {
      await streamChat({
        conversationId: activeId ?? undefined,
        content,
        mode: sendMode,
        token: accessToken,
        signal: controller.signal,
        onEvent: handleEvent,
      })
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setError(err instanceof Error ? err.message : '请求失败')
      }
    } finally {
      // 以服务端为准刷新消息与会话列表（首轮 meta 可能返回新建会话 id）
      const finalId = createdId ?? activeId
      if (finalId) {
        try {
          const { messages: msgs } = await listMessages(finalId)
          setMessages(msgs.map((m) => toDisplay(m)))
          setActiveId(finalId)
        } catch {
          // ignore
        }
      }
      await refreshConversations()
      setSending(false)
      abortRef.current = null
    }
  }

  // ---- 会话操作 ----
  async function handleRename(conv: Conversation) {
    const title = window.prompt('重命名会话：', conv.title)
    if (!title || title.trim() === conv.title || !title.trim()) return
    try {
      await renameConversation(conv.id, title.trim())
      await refreshConversations()
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败')
    }
  }

  async function handleDelete(conv: Conversation) {
    if (!window.confirm(`确定删除会话「${conv.title}」？消息将一并删除。`)) return
    try {
      await deleteConversation(conv.id)
      if (activeId === conv.id) newChat()
      await refreshConversations()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  // ---- 输入 ----
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  function stopGenerating() {
    abortRef.current?.abort()
  }

  // ---- 自动滚动 ----
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sending])

  return (
    <div className="chat-layout">
      {/* 侧栏 */}
      <aside className="sidebar">
        <div className="sidebar-head">
          <button className="btn-new-chat" onClick={newChat}>
            <span className="plus">+</span> 新对话
          </button>
        </div>
        <nav className="conv-list">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`conv-item ${c.id === activeId ? 'active' : ''}`}
              onClick={() => void openConversation(c.id)}
            >
              <span className="conv-title">{c.title}</span>
              <span className="conv-actions">
                <button
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleRename(c)
                  }}
                >
                  ✎
                </button>
                <button
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    void handleDelete(c)
                  }}
                >
                  🗑
                </button>
              </span>
            </div>
          ))}
          {conversations.length === 0 && <div className="conv-empty">暂无历史会话</div>}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip">
            <span className="avatar sm">{(user?.display_name ?? user?.username ?? '?').slice(0, 1)}</span>
            <div className="user-meta">
              <div className="user-name">{user?.display_name ?? user?.username}</div>
              <div className="user-role">{user?.role}</div>
            </div>
            <button
              title="退出登录"
              className="logout-btn"
              onClick={() => {
                clearAuth()
                window.location.href = '/login'
              }}
            >
              ⎋
            </button>
          </div>
        </div>
      </aside>

      {/* 主区 */}
      <main className="chat-main">
        {/* 顶部：标题 + 模式 */}
        <header className="chat-toolbar">
          <div className="toolbar-left">
            <span className="toolbar-title">{activeConv ? activeConv.title : '新对话'}</span>
            <span className={`mode-pill mode-${activeConv ? activeConv.mode : draftMode}`}>
              {MODE_LABELS[activeConv ? activeConv.mode : draftMode]}
            </span>
          </div>
          {!activeConv && (
            <div className="mode-picker">
              <span>模式：</span>
              {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
                <button
                  key={m}
                  className={`mode-opt ${draftMode === m ? 'active' : ''}`}
                  onClick={() => setDraftMode(m)}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          )}
        </header>

        {/* 消息区 */}
        <div className="messages">
          {messages.length === 0 && !sending && (
            <div className="welcome">
              <div className="welcome-logo">🎓</div>
              <h2>教育版智能学伴</h2>
              <p>多轮对话 · 流式输出 · 学伴 / 练习 / 教师三种模式</p>
              <div className="suggestions">
                {WELCOME_SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => void handleSend(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg-row ${m.role}`}>
              <div className="msg-avatar">{m.role === 'assistant' ? 'AI' : '你'}</div>
              <div className="msg-bubble">
                {m.role === 'assistant' ? (
                  <div className="markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                    {m.pending && <span className="cursor-blink">▍</span>}
                  </div>
                ) : (
                  <div className="user-text">{m.content}</div>
                )}
              </div>
            </div>
          ))}
          {error && (
            <div className="error-banner">
              <span>⚠ {error}</span>
              <button onClick={() => setError('')}>✕</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="composer-wrap">
          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
              rows={1}
            />
            {sending ? (
              <button className="btn-stop" onClick={stopGenerating} title="停止生成">
                ■
              </button>
            ) : (
              <button className="btn-send" onClick={() => void handleSend()} disabled={!input.trim()} title="发送">
                ➤
              </button>
            )}
          </div>
          <p className="composer-hint">学伴 AI 生成内容仅供参考，请以教材与老师讲解为准。</p>
        </div>
      </main>
    </div>
  )
}
