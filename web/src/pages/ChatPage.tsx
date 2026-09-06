import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  deleteConversation,
  downloadArtifact,
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
import FileIcon from '../components/FileIcon'
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
  id?: string
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

const WELCOME_GUIDES = [
  {
    icon: '💬',
    title: '苏格拉底式答疑',
    desc: '让 AI 引导你理解概念，而非直接给答案',
    prompt: '用苏格拉底式提问帮我理解「导数」的概念',
  },
  {
    icon: '📝',
    title: '练习与测评',
    desc: '按难度出题、批改作答、诊断薄弱点',
    prompt: '生成 5 道一元二次方程练习题',
  },
  {
    icon: '📄',
    title: '生成学习文件',
    desc: '一键产出 docx 试卷 / pptx 课件 / 图表 / PDF',
    prompt: '用 execute_code 生成一份三角函数教案 docx',
  },
  {
    icon: '📚',
    title: '资料库问答',
    desc: '上传讲义后，AI 基于你的资料作答并标注出处',
    prompt: '根据我的资料库讲一下勾股定理的证明思路',
  },
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

/** 会话按时间分组：今天 / 昨天 / 更早。 */
interface ConvGroup {
  label: string
  items: Conversation[]
}
function groupByDay(list: Conversation[]): ConvGroup[] {
  const now = new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOf(now)
  const yesterday = today - 86400_000
  const sorted = [...list].sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  )
  const groups: ConvGroup[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '更早', items: [] },
  ]
  for (const c of sorted) {
    const t = new Date(c.updated_at).getTime()
    if (t >= today) groups[0].items.push(c)
    else if (t >= yesterday) groups[1].items.push(c)
    else groups[2].items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

const MODE_ICONS: Record<string, string> = {
  companion: '🎓',
  practice: '📝',
  teacher: '🖊️',
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
          const rawArts = Array.isArray(data.artifacts)
            ? (data.artifacts as unknown[])
            : []
          const artifacts = rawArts.map((a) => a as ToolArtifact)
          setToolSteps((prev) =>
            prev.map((s) =>
              s.name === name && s.running ? { ...s, summary, running: false, artifacts } : s,
            ),
          )
          // 产物同步挂到本条 assistant 消息：流结束后 tool-steps 卸载，
          // 由 HistoryArtifacts（带 data 即时显示 + 服务器 blob 下载）无缝接管，避免"闪一下就没了"。
          const persistent = artifacts.filter((a) => typeof a.id === 'string' && a.id)
          if (persistent.length > 0) {
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (!last || last.role !== 'assistant' || !last.pending) return prev
              const known = new Set((last.artifacts ?? []).map((x) => x.id))
              const fresh = persistent
                .filter((a) => !known.has(a.id as string))
                .map((a) => ({
                  id: a.id as string,
                  name: a.name,
                  mime: a.mime,
                  data: a.data,
                }))
              if (fresh.length === 0) return prev
              const merged = [...(last.artifacts ?? []), ...fresh]
              return [...prev.slice(0, -1), { ...last, artifacts: merged }]
            })
          }
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
          <div className="brand-bar">
            <div className="ccnu-emblem">华</div>
            <div>
              <div className="brand-bar-title">华中师范大学</div>
              <div className="brand-bar-sub">教育版智能学伴</div>
            </div>
          </div>
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
          {user?.role === 'admin' && (
            <Link to="/monitor" className="side-nav-item">
              🛰️ 监控中心
            </Link>
          )}
        </nav>
        <nav className="conv-list">
          {(() => {
            const groups = groupByDay(conversations)
            return groups.map((g) =>
              g.items.length === 0 ? null : (
                <div key={g.label} className="conv-group">
                  <div className="conv-group-label">{g.label}</div>
                  {g.items.map((c) => (
                    <div
                      key={c.id}
                      className={`conv-item ${c.id === activeId ? 'active' : ''}`}
                      onClick={() => void openConversation(c.id)}
                    >
                      <span className="conv-avatar">{MODE_ICONS[c.mode] ?? '💬'}</span>
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
                </div>
              ),
            )
          })()}
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
              <div className="welcome-hero">
                <div className="welcome-hero-emblem">
                  <div className="ccnu-emblem lg">华</div>
                </div>
                <h2 className="ccnu-wordmark">华中师范大学 · 智能学伴</h2>
                <p className="welcome-slogan">求实创新 · 立德树人</p>
                <p className="welcome-sub">
                  多轮对话 · 流式输出 · 输入 <code>/</code> 唤起 Skill · 生成可下载的学习文件
                </p>
              </div>
              <div className="welcome-guides">
                {WELCOME_GUIDES.map((g) => (
                  <button
                    key={g.title}
                    className="guide-card"
                    onClick={() => void handleSend(g.prompt)}
                  >
                    <span className="guide-icon">{g.icon}</span>
                    <span className="guide-text">
                      <span className="guide-title">{g.title}</span>
                      <span className="guide-desc">{g.desc}</span>
                    </span>
                    <span className="guide-arrow">↗</span>
                  </button>
                ))}
              </div>
              <p className="welcome-tip">试试直接提问，或点击上方引导卡开始</p>
            </div>
          )}
          {messages.map((m, mi) => {
            const isStreamingBot = m.role === 'assistant' && m.pending
            return (
              <div key={m.id} className={`msg-row ${m.role}`}>
                <div className="msg-avatar">
                  {m.role === 'assistant' ? (
                    <span className="avatar-ai">学</span>
                  ) : (
                    <span className="avatar-you">
                      {(user?.display_name ?? user?.username ?? '我').slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </div>
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
                                      <div
                                        key={i}
                                        className="artifact-img-wrap"
                                        role="button"
                                        tabIndex={0}
                                        title={`下载 ${a.name}`}
                                        onClick={() => void downloadArtifact(a).catch(() => {})}
                                        onKeyDown={(e) => {
                                          if (e.key === 'Enter') void downloadArtifact(a).catch(() => {})
                                        }}
                                      >
                                        <img
                                          className="artifact-img"
                                          src={`data:${a.mime};base64,${a.data}`}
                                          alt={a.name}
                                        />
                                        <span className="artifact-name">
                                          <FileIcon name={a.name} mime={a.mime} size={16} /> {a.name} ⬇
                                        </span>
                                      </div>
                                    ) : (
                                      <button
                                        key={i}
                                        className="artifact-file"
                                        title={`下载 ${a.name}`}
                                        disabled={!a.id && !a.data}
                                        onClick={() => void downloadArtifact(a).catch(() => {})}
                                      >
                                        <FileIcon name={a.name} mime={a.mime} size={16} />
                                        {a.name}
                                        {a.data && a.mime === 'text/csv' && a.data.length < 2000
                                          ? `（${a.data.length} 字符）`
                                          : a.id
                                            ? '（点击下载）'
                                            : ''}
                                      </button>
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
