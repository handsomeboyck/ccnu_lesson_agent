import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  deleteConversation,
  listConversations,
  listMessages,
  listSkills,
  logout,
  renameConversation,
  type CommandInfo,
  type ServerMessage,
  type ServerMessageArtifact,
} from '../api/client'
import { streamChat } from '../api/sse'
import { useAuth } from '../store/auth'
import HistoryArtifacts from '../components/HistoryArtifacts'
import { MODE_LABELS, type Conversation, type Mode, type SSEEvent } from '../types'

// 本地展示消息（含流式中占位）
interface DisplayMsg {
  id: string
  role: 'user' | 'assistant'
  content: string
  pending?: boolean
  artifacts?: ServerMessageArtifact[] // 历史消息持久化产物（回看）
}

// 一次工具调用（卡片展示）
interface ToolArtifact {
  name: string
  mime: string
  data?: string
}
interface ToolStep {
  key: string
  name: string
  summary?: string
  running: boolean
  artifacts?: ToolArtifact[]
}

// ask_user 等待回答状态
interface PendingAsk {
  question: string
  options?: string[]
}

const WELCOME_SUGGESTIONS = [
  '用苏格拉底式提问帮我理解「导数」的概念',
  '生成 5 道一元二次方程练习题',
  '请讲解勾股定理的证明思路',
]

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/** 服务端消息 → 展示消息。 */
function toDisplay(m: ServerMessage): DisplayMsg {
  return {
    id: m.id,
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content,
    artifacts: m.artifacts && m.artifacts.length > 0 ? m.artifacts : undefined,
  }
}

export default function ChatPage() {
  const user = useAuth((s) => s.user)
  const accessToken = useAuth((s) => s.accessToken)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<DisplayMsg[]>([])
  const [toolSteps, setToolSteps] = useState<ToolStep[]>([])
  const [draftMode, setDraftMode] = useState<Mode>('companion')
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null)
  const [slashMenu, setSlashMenu] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const activeConv = conversations.find((c) => c.id === activeId) ?? null

  // ---- 初始化 ----
  useEffect(() => {
    void refreshConversations()
    void listSkills()
      .then(({ commands: list }) => setCommands(list))
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- 会话 ----
  const refreshConversations = useCallback(async () => {
    try {
      const { conversations: list } = await listConversations()
      setConversations(list)
    } catch {
      // 静默
    }
  }, [])

  const openConversation = useCallback(async (id: string) => {
    abortRef.current?.abort()
    setActiveId(id)
    setError('')
    setSending(false)
    setPendingAsk(null)
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
    setPendingAsk(null)
    setError('')
    setSending(false)
  }, [])

  // ---- 发送 ----
  async function handleSend(rawContent?: string) {
    const content = (rawContent ?? input).trim()
    if (!content || sending || !accessToken) return

    setInput('')
    setSlashMenu(false)
    setError('')
    setSending(true)
    setToolSteps([])
    // 学生回答问题（pendingAsk 存在时本轮是它的回答），发送后清除等待态
    setPendingAsk(null)

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
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (!last || !last.pending) return prev
              return [...prev.slice(0, -1), { ...last, content: last.content + text }]
            })
          }
        } else if (ev.event === 'tool_call') {
          setToolSteps((prev) => [
            ...prev,
            { key: uid(), name: String(data.name ?? ''), summary: '调用中…', running: true },
          ])
        } else if (ev.event === 'tool_result') {
          const name = String(data.name ?? '')
          const summary = String(data.summary ?? '执行完成')
          const artifacts = Array.isArray(data.artifacts)
            ? (data.artifacts as unknown[]).map((a) => a as ToolArtifact)
            : undefined
          setToolSteps((prev) =>
            prev.map((s) =>
              s.name === name && s.running ? { ...s, summary, running: false, artifacts } : s,
            ),
          )
        } else if (ev.event === 'ask') {
          const question = String(data.question ?? '')
          const options = Array.isArray(data.options)
            ? (data.options as unknown[]).map(String).filter(Boolean)
            : undefined
          if (question) {
            // 助手气泡展示问题；进入“等待学生回答”状态
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last && last.pending) {
                return [...prev.slice(0, -1), { ...last, content: question, pending: false }]
              }
              return prev
            })
            setPendingAsk({ question, options })
          }
        } else if (ev.event === 'error') {
          setError(String(data.message ?? '生成出错'))
        }
      } catch {
        // 忽略
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
      setMessages((prev) => prev.map((m) => (m.pending ? { ...m, pending: false } : m)))
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

  // ---- / 命令菜单 ----
  const slashQuery = input.startsWith('/') ? input.slice(1) : ''
  const filteredCommands =
    slashQuery === ''
      ? commands
      : commands.filter(
          (c) =>
            c.command.includes(slashQuery.toLowerCase()) ||
            c.aliases.some((a) => a.toLowerCase().includes(slashQuery.toLowerCase())),
        )

  function applyCommand(c: CommandInfo) {
    setInput(`/${c.command} `)
    setSlashMenu(false)
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
  }

  function onInputChange(value: string) {
    setInput(value)
    setSlashMenu(value.startsWith('/') && !value.includes(' '))
  }

  // ---- 输入 ----
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      setSlashMenu(false)
      return
    }
    if (slashMenu && filteredCommands.length > 0 && (e.key === 'Tab' || e.key === 'Enter')) {
      if (e.key === 'Enter' && !e.shiftKey) {
        // 命令未选定不直接发；仍允许原样发送完整指令
        return
      }
      e.preventDefault()
      applyCommand(filteredCommands[0])
      return
    }
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
        <nav className="side-nav">
          <Link to="/library" className="side-nav-item">
            📚 我的资料库
          </Link>
          <Link to="/artifacts" className="side-nav-item">
            🗂️ 产物库
          </Link>
          <Link to="/skills" className="side-nav-item">
            🧩 技能管理
          </Link>
        </nav>
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
          </div>
          <button
            className="btn-logout"
            onClick={() => {
              void logout()
              window.location.href = '/login'
            }}
          >
            ⎋ 退出登录
          </button>
        </div>
      </aside>

      {/* 主区 */}
      <main className="chat-main">
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

        {/* Skill 面板（新对话时） */}
        {!activeConv && commands.length > 0 && (
          <div className="skill-panel">
            <span className="skill-panel-label">内置 Skill（输入 / 唤起）：</span>
            {commands.map((c) => (
              <button key={c.skill} className="skill-chip" title={c.description} onClick={() => applyCommand(c)}>
                /{c.command}
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
              <p>多轮对话 · 流式输出 · 输入 <code>/</code> 主动唤起 Skill</p>
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
                      {isStreamingBot && mi === messages.length - 1 && toolSteps.length > 0 && (
                        <div className="tool-steps">
                          {toolSteps.map((t) => (
                            <div key={t.key} className="tool-step-block">
                              <div className={`tool-card ${t.running ? 'running' : 'done'}`}>
                                <span className="tool-card-icon">{t.running ? '⚙' : '✓'}</span>
                                <span className="tool-card-name">{t.name}</span>
                                <span className="tool-card-summary">{t.summary}</span>
                              </div>
                              {t.artifacts && t.artifacts.length > 0 && (
                                <div className="tool-artifacts">
                                  {t.artifacts.map((a, i) =>
                                    a.data && a.mime.startsWith('image/') ? (
                                      <a
                                        key={i}
                                        className="artifact-img-wrap"
                                        href={`data:${a.mime};base64,${a.data}`}
                                        download={a.name}
                                        title={`下载 ${a.name}`}
                                      >
                                        <img
                                          className="artifact-img"
                                          src={`data:${a.mime};base64,${a.data}`}
                                          alt={a.name}
                                        />
                                        <span className="artifact-name">📎 {a.name}</span>
                                      </a>
                                    ) : (
                                      <span key={i} className="artifact-file">
                                        📄 {a.name}
                                        {a.data && a.mime === 'text/csv' && a.data.length < 2000
                                          ? `（${a.data.length} 字符）`
                                          : ''}
                                      </span>
                                    ),
                                  )}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      {m.pending && <span className="cursor-blink">▍</span>}
                      {m.artifacts && m.artifacts.length > 0 && !isStreamingBot && (
                        <HistoryArtifacts artifacts={m.artifacts} />
                      )}
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
          {pendingAsk && !sending && (
            <div className="ask-banner">
              <span className="ask-icon">🫵</span>
              <span>助手在等你回答上面的问题，输入后发送即可继续。</span>
              {pendingAsk.options && pendingAsk.options.length > 0 && (
                <span className="ask-options">
                  {pendingAsk.options.map((o) => (
                    <button key={o} className="ask-option" onClick={() => void handleSend(o)}>
                      {o}
                    </button>
                  ))}
                </span>
              )}
            </div>
          )}
          <div className="composer-relative">
            {slashMenu && filteredCommands.length > 0 && (
              <div className="slash-menu">
                {filteredCommands.map((c) => (
                  <button key={c.skill} className="slash-item" onClick={() => applyCommand(c)}>
                    <span className="slash-cmd">/{c.command}</span>
                    <span className="slash-desc">{c.description}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="composer">
              <textarea
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  pendingAsk ? '回答助手的问题…' : '输入消息… 输入 / 唤起 Skill，Enter 发送'
                }
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
          </div>
          <p className="composer-hint">学伴 AI 生成内容仅供参考，学习请以教材与老师讲解为准。</p>
        </div>
      </main>
    </div>
  )
}
