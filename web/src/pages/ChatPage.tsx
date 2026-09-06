import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  deleteConversation,
  listConversations,
  listMessages,
  listSkills,
  renameConversation,
  type ServerMessage,
  type SkillInfo,
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

// 一次工具调用（卡片展示）
interface ToolStep {
  key: string
  name: string
  summary?: string
  running: boolean
}

// Skill 点击时预填的示例指令
const SKILL_PRESETS: Record<string, string> = {
  quiz_generator: '请用练习模式生成 5 道一元二次方程练习题',
  explain_topic: '请讲解「导数」这个概念，并用苏格拉底式提问引导我',
  knowledge_retrieve: '请结合课程资料回答：',
}

const WELCOME_SUGGESTIONS = [
  '用苏格拉底式提问帮我理解「导数」的概念',
  '生成 5 道一元二次方程练习题',
  '请讲解勾股定理的证明思路',
]

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** 服务端消息 → 展示消息（M0/M1 仅 user/assistant）。 */
function toDisplay(m: ServerMessage): DisplayMsg {
  return { id: m.id, role: m.role === 'user' ? 'user' : 'assistant', content: m.content }
}

export default function ChatPage() {
  const user = useAuth((s) => s.user)
  const accessToken = useAuth((s) => s.accessToken)
  const clearAuth = useAuth((s) => s.clear)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMsg[]>([])
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([])
  const [draftMode, setDraftMode] = useState<Mode>('companion')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeConv = conversations.find((c) => c.id === activeId) ?? null

  // ---- 初始化：会话列表 + Skill 清单 ----
  useEffect(() => {
    void refreshConversations()
    void listSkills()
      .then(({ skills: list }) => setSkills(list))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 会话列表 ----
  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: list } = await listConversations()
      setConversations(list)
    } catch {
      // 静默（401 由拦截器处理）
    }
  }, [])

  // ---- 载入/切换会话 ----
  const openConversation = useCallback(async (id: string) => {
    abortRef.current?.abort()
    setActiveId(id)
    setError('')
    setSending(false)
    setToolSteps([])
    setMessages([])
    try {
      const { messages: msgs } = await listMessages(id)
      setMessages(msgs.map((m) => toDisplay(m)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载消息失败')
    }
  }, [])

  const newChat = useCallback(() => {
    abortRef.current?.abort()
    setActiveId(null)
    setMessages([])
    setToolSteps([])
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
    setToolSteps([])

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
        const data = JSON.parse(ev.data) as Record<string, unknown>
        if (ev.event === 'meta') {
          if (typeof data.conversation_id === 'string') createdId = data.conversation_id
        } else if (ev.event === 'delta') {
          const text = String(data.text ?? '')
          if (text) {
            // 注意：必须写纯 updater（不 mutate prev 内对象）。
            // StrictMode 开发模式会双调 updater，若直接改 last.content 会导致每段文本追加两次。
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (!last || !last.pending) return prev
              return [...prev.slice(0, -1), { ...last, content: last.content + text }]
            })
          }
        } else if (ev.event === 'tool_call') {
          const name = String(data.name ?? '')
          setToolSteps((prev) => [
            ...prev,
            { key: uid(), name, summary: '调用中…', running: true },
          ])
        } else if (ev.event === 'tool_result') {
          const name = String(data.name ?? '')
          const summary = String(data.summary ?? '执行完成')
          setToolSteps((prev) =>
            prev.map((s) => (s.name === name && s.running ? { ...s, summary, running: false } : s)),
          )
        } else if (ev.event === 'error') {
          setError(String(data.message ?? '生成出错'))
        }
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
      // 本地流式内容已与服务端一致；收尾标记并刷新会话列表
      setMessages((prev) =>
        prev.map((m) => (m.pending ? { ...m, pending: false } : m)),
      )
      if (createdId && createdId !== activeId) setActiveId(createdId)
      await refreshConversations()
      setSending(false)
      abortRef.current = null
    }
  }

  // ---- 会话操作 ----
  async function handleRename(conv: Conversation) {
    const title = window.prompt('重命名会话：', conv.title)
    if (!title || !title.trim() || title.trim() === conv.title) return
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

  function pickSkill(s: SkillInfo) {
    const preset = SKILL_PRESETS[s.name] ?? `请调用 ${s.name}：`
    setInput(preset)
    // 聚焦输入框
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
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
  }, [messages, toolSteps, sending])

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

        {/* Skill 面板（新对话时展示，点击预填指令） */}
        {!activeConv && skills.length > 0 && (
          <div className="skill-panel">
            <span className="skill-panel-label">内置 Skill：</span>
            {skills.map((s) => (
              <button key={s.name} className="skill-chip" title={s.description} onClick={() => pickSkill(s)}>
                {s.name}
              </button>
            ))}
          </div>
        )}

        {/* 消息区 */}
        <div className="messages">
          {messages.length === 0 && !sending && (
            <div className="welcome">
              <div className="welcome-logo">🎓</div>
              <h2>教育版智能学伴</h2>
              <p>多轮对话 · 流式输出 · 内置 Skill · 学伴 / 练习 / 教师三种模式</p>
              <div className="suggestions">
                {WELCOME_SUGGESTIONS.map((s) => (
                  <button key={s} className="suggestion" onClick={() => void handleSend(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, mi) => {
            const isStreamingBot = m.role === 'assistant' && m.pending
            return (
              <div key={m.id} className={`msg-row ${m.role}`}>
                <div className="msg-avatar">{m.role === 'assistant' ? 'AI' : '你'}</div>
                <div className="msg-bubble">
                  {m.role === 'assistant' ? (
                    <div className="markdown-body">
                      {/* 工具调用卡片（仅挂在本轮流式的最后一条 assistant 消息上） */}
                      {isStreamingBot && mi === messages.length - 1 && toolSteps.length > 0 && (
                        <div className="tool-steps">
                          {toolSteps.map((t) => (
                            <div key={t.key} className={`tool-card ${t.running ? 'running' : 'done'}`}>
                              <span className="tool-card-icon">{t.running ? '⚙' : '✓'}</span>
                              <span className="tool-card-name">{t.name}</span>
                              <span className="tool-card-summary">{t.summary}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      {m.pending && <span className="cursor-blink">▍</span>}
                    </div>
                  ) : (
                    <div className="user-text">{m.content}</div>
                  )}
                </div>
              </div>
            )
          })}
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
          <p className="composer-hint">学伴 AI 生成内容仅供参考，学习请以教材与老师讲解为准。</p>
        </div>
      </main>
    </div>
  )
}
