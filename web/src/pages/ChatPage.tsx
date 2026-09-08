// ChatPage v2：AI SDK v7 useChat + UI message stream 协议。
// 消息渲染基于 parts（text / reasoning / tool-* / data-ccnu），四类卡片：
// 思考卡（ThinkingCard）、工具卡（ToolCard）、产物卡（ArtifactCards）、提问卡（AskCard）。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import {
  Activity,
  FolderOpen,
  Library,
  LogOut,
  NotebookPen,
  Paperclip,
  Plus,
  Puzzle,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  Pencil,
} from 'lucide-react'
import {
  deleteConversation,
  listConversations,
  listMessages,
  listSkills,
  logout,
  renameConversation,
  uploadChatAttachments,
  type CommandInfo,
  type ServerMessage,
  type ServerMessageArtifact,
} from '../api/client'
import { useAuth } from '../store/auth'
import FileIcon from '../components/FileIcon'
import { Button } from '../components/ui/button'
import { MODE_LABELS, type Conversation, type Mode } from '../types'
import ChatMarkdown from '../components/chat/ChatMarkdown'
import ToolCard from '../components/chat/ToolCard'
import AskCard from '../components/chat/AskCard'
import ArtifactCards from '../components/chat/ArtifactCards'
import { ThinkingCard, ThinkingIndicator } from '../components/chat/ThinkingCard'

// ---- 常量与工具 ----

const WELCOME_GUIDES = [
  {
    icon: Sparkles,
    title: '苏格拉底式答疑',
    desc: '引导你理解概念，而非直接给答案',
    prompt: '用苏格拉底式提问帮我理解「导数」的概念',
  },
  {
    icon: NotebookPen,
    title: '练习与测评',
    desc: '按难度出题、批改作答、诊断薄弱点',
    prompt: '生成 5 道一元二次方程练习题',
  },
  {
    icon: Search,
    title: '生成学习文件',
    desc: '一键产出 docx 试卷 / pptx 课件 / 图表 / PDF',
    prompt: '用 execute_code 生成一份三角函数教案 docx',
  },
  {
    icon: Library,
    title: '资料库问答',
    desc: '上传讲义后，AI 基于你的资料作答并标注出处',
    prompt: '根据我的资料库讲一下勾股定理的证明思路',
  },
]

const MODE_ICONS: Record<string, string> = { companion: '🎓', practice: '📝', teacher: '🖊️' }

/** 历史消息（REST）→ AI SDK UIMessage（工具轨迹/产物映射为 parts）。 */
function historyToMessages(msgs: ServerMessage[]): UIMessage[] {
  return msgs.map((m) => {
    const parts: UIMessage['parts'] = []
    if (m.role === 'assistant') {
      // 思考链（发生顺序：思考 → 工具 → 文本）
      if (m.reasoning) {
        parts.push({ type: 'reasoning', text: m.reasoning, state: 'done' } as UIMessage['parts'][number])
      }
      for (const [i, t] of (m.tool_steps ?? []).entries()) {
        parts.push({
          type: `tool-${t.name}`,
          toolCallId: t.call_id ?? `hist-${i}`,
          state: 'output-available',
          output: { summary: t.summary, artifacts: t.artifacts ?? [] },
          providerExecuted: true,
        } as UIMessage['parts'][number])
      }
      if (m.artifacts && m.artifacts.length > 0) {
        parts.push({
          type: 'data-ccnu',
          data: { type: 'artifacts', artifacts: m.artifacts },
        } as UIMessage['parts'][number])
      }
    }
    parts.push({ type: 'text', text: m.content } as UIMessage['parts'][number])
    return { id: m.id, role: m.role === 'user' ? 'user' : 'assistant', parts } as UIMessage
  })
}

/** 会话按时间分组：今天 / 昨天 / 更早。 */
function groupByDay(list: Conversation[]): { label: string; items: Conversation[] }[] {
  const now = new Date()
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const today = startOf(now)
  const yesterday = today - 86400_000
  const sorted = [...list].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
  const groups = [
    { label: '今天', items: [] as Conversation[] },
    { label: '昨天', items: [] as Conversation[] },
    { label: '更早', items: [] as Conversation[] },
  ]
  for (const c of sorted) {
    const t = new Date(c.updated_at).getTime()
    if (t >= today) groups[0].items.push(c)
    else if (t >= yesterday) groups[1].items.push(c)
    else groups[2].items.push(c)
  }
  return groups.filter((g) => g.items.length > 0)
}

function fmtFileSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function mimeOf(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'pdf':
      return 'application/pdf'
    case 'docx':
    case 'doc':
      return 'application/msword'
    case 'xlsx':
    case 'xls':
      return 'application/vnd.ms-excel'
    case 'csv':
      return 'text/csv'
    default:
      return 'text/plain'
  }
}

// ---- 主组件 ----

export default function ChatPage() {
  const user = useAuth((s) => s.user)
  const accessToken = useAuth((s) => s.accessToken)

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [draftMode, setDraftMode] = useState<Mode>('companion')
  const [input, setInput] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const [error, setError] = useState('')
  const [slashMenu, setSlashMenu] = useState(false)

  const convIdRef = useRef('')
  const modeRef = useRef<string>('companion')
  const attachRef = useRef<string[]>([])
  const sendingRef = useRef(false) // 同步发送锁：防止双击/连发产生并发流（会破坏 SDK 消息列表）
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const activeConv = conversations.find((c) => c.id === activeId) ?? null

  // ---- AI SDK chat（v7：显式 transport + 请求适配层）----
  const { messages, setMessages, sendMessage, status, stop, error: chatError } = useChat({
    transport: new DefaultChatTransport<UIMessage>({
      api: '/v1/chat',
      headers: () => ({ Authorization: `Bearer ${useAuth.getState().accessToken ?? ''}` }),
      body: { mode: 'companion' },
      prepareSendMessagesRequest: ({ messages: msgs, headers }) => {
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
        const text = (lastUser?.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('')
          .split('\n')
          .filter((l) => !l.startsWith('📎 ')) // 展示用附件标记剥离
          .join('\n')
          .trim()
        const attachments = attachRef.current
        return {
          api: '/v1/chat',
          headers,
          body: {
            conversation_id: convIdRef.current,
            content: text || (attachments.length > 0 ? '请阅读我上传的文件并给出简要总结。' : ''),
            mode: modeRef.current,
            attachments: attachments.length > 0 ? attachments : undefined,
          },
        }
      },
    }),
  })
  const streaming = status === 'streaming' || status === 'submitted'

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

  const openConversation = useCallback(
    async (id: string) => {
      if (streaming) stop()
      setActiveId(id)
      setError('')
      const conv = conversations.find((c) => c.id === id)
      if (conv) modeRef.current = conv.mode
      try {
        const { messages: msgs } = await listMessages(id)
        convIdRef.current = id
        attachRef.current = []
        setMessages(historyToMessages(msgs))
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载消息失败')
      }
    },
    [conversations, streaming, stop, setMessages],
  )

  const newChat = useCallback(() => {
    if (streaming) stop()
    setActiveId(null)
    setError('')
    convIdRef.current = ''
    attachRef.current = []
    setMessages([])
    setPendingFiles([])
    modeRef.current = draftMode
  }, [streaming, stop, setMessages, draftMode])

  // ---- meta/done 数据 part 消费（会话 id 回传 / 标题刷新）----
  useEffect(() => {
    for (const m of messages) {
      for (const p of m.parts as unknown as { type: string; data?: Record<string, unknown> }[]) {
        if (p.type === 'data-ccnu' && p.data?.type === 'meta' && typeof p.data.conversation_id === 'string') {
          const cid = p.data.conversation_id
          convIdRef.current = cid
          setActiveId((prev) => (prev && prev !== cid ? prev : cid))
          void refreshConversations()
        } else if (p.type === 'data-ccnu' && p.data?.type === 'done') {
          void refreshConversations()
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages])

  // 流结束/出错后解锁发送（status 异步更新，配合 sendingRef 同步锁）
  useEffect(() => {
    if (status === 'ready' || status === 'error') sendingRef.current = false
  }, [status])

  // ---- 提问状态（从最后一条助手消息的 ask part 派生）----
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const askPart = (lastAssistant?.parts ?? []).find(
    (p) =>
      (p as { type?: string }).type === 'data-ccnu' &&
      (p as { data?: { type?: string } }).data?.type === 'ask',
  ) as { data?: { question?: string; options?: string[] } } | undefined
  const pendingAsk = !streaming && askPart?.data?.question ? askPart.data : null

  function answerAsk(option: string) {
    if (streaming || sendingRef.current) return
    sendingRef.current = true
    attachRef.current = []
    void sendMessage({ text: option })
  }

  // ---- 附件 ----
  function addFiles(list: FileList | File[]) {
    const files = Array.from(list)
    const ok: File[] = []
    for (const f of files) {
      if (pendingFiles.length + ok.length >= 5) {
        setError('一次最多附加 5 个文件')
        break
      }
      if (pendingFiles.some((p) => p.name === f.name && p.size === f.size)) continue
      ok.push(f)
    }
    if (ok.length > 0) setPendingFiles((prev) => [...prev, ...ok])
  }
  function removeFile(name: string, size: number) {
    setPendingFiles((prev) => prev.filter((f) => !(f.name === name && f.size === size)))
  }

  // ---- 发送 ----
  async function handleSend(rawContent?: string) {
    const content = (rawContent ?? input).trim()
    if (!accessToken || streaming || sendingRef.current) return
    if (!content && pendingFiles.length === 0) return
    sendingRef.current = true

    let attachIds: string[] = []
    const failed: string[] = []
    if (pendingFiles.length > 0) {
      setUploading(true)
      try {
        const results = await uploadChatAttachments(pendingFiles)
        for (const r of results) {
          if (r.status === 'ready' && r.doc_id) attachIds.push(r.doc_id)
          else if (r.error) failed.push(`${r.filename}：${r.error}`)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '附件上传失败')
        setUploading(false)
        sendingRef.current = false // 上传失败释放发送锁
        return
      } finally {
        setUploading(false)
      }
    }

    modeRef.current = activeConv ? activeConv.mode : draftMode
    attachRef.current = attachIds
    setInput('')
    setSlashMenu(false)
    setError('')

    // 展示文本：原文 + 附件标记（适配层会剥离 📎 行）
    let display = content
    if (attachIds.length > 0) {
      const names = pendingFiles.map((f) => f.name)
      if (names.length > 0) display = (display ? display + '\n\n' : '') + names.map((n) => `📎 ${n}`).join('\n')
    }
    setPendingFiles([])
    if (failed.length > 0) setError(`部分附件失败：${failed.join('；')}`)
    void sendMessage({ text: display })
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
    document.querySelector<HTMLTextAreaElement>('textarea')?.focus()
  }
  function onInputChange(value: string) {
    setInput(value)
    setSlashMenu(value.startsWith('/') && !value.includes(' '))
  }
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      setSlashMenu(false)
      return
    }
    if (slashMenu && filteredCommands.length > 0 && e.key === 'Tab') {
      e.preventDefault()
      applyCommand(filteredCommands[0])
      return
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  // ---- 自动滚动 ----
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, status])

  // ---- 渲染 ----
  return (
    <div className="flex h-full overflow-hidden bg-background text-foreground">
      {/* 侧栏 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ccnu-blue font-display text-lg font-bold text-white shadow-sm">
            华
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-sm font-bold">华中师范大学</div>
            <div className="text-[11px] text-muted-foreground">教育版智能学伴</div>
          </div>
        </div>
        <div className="px-3 pb-3">
          <Button className="w-full justify-start gap-2" size="sm" onClick={newChat}>
            <Plus className="size-4" /> 新对话
          </Button>
        </div>
        <nav className="space-y-0.5 px-3">
          <Link to="/library" className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <Library className="size-4" /> 我的资料库
          </Link>
          <Link to="/artifacts" className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <FolderOpen className="size-4" /> 产物库
          </Link>
          <Link to="/skills" className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <Puzzle className="size-4" /> 技能管理
          </Link>
          {user?.role === 'admin' && (
            <Link to="/monitor" className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <Activity className="size-4" /> 监控中心
            </Link>
          )}
        </nav>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3">
          {(() => {
            const groups = groupByDay(conversations)
            return groups.map((g) => (
              <div key={g.label} className="mb-2">
                <div className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{g.label}</div>
                {g.items.map((c) => (
                  <div
                    key={c.id}
                    className={`group flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-sm ${
                      c.id === activeId ? 'bg-ccnu-blue/10 text-ccnu-blue-deep' : 'text-foreground hover:bg-accent'
                    }`}
                    onClick={() => void openConversation(c.id)}
                  >
                    <span className="text-xs">{MODE_ICONS[c.mode] ?? '💬'}</span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="hidden shrink-0 gap-0.5 group-hover:flex">
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="重命名"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleRename(c)
                        }}
                      >
                        <Pencil className="size-3" />
                      </button>
                      <button
                        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDelete(c)
                        }}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ))
          })()}
          {conversations.length === 0 && (
            <div className="px-2.5 py-3 text-center text-xs text-muted-foreground">暂无历史会话</div>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
            {(user?.display_name ?? user?.username ?? '?').slice(0, 1)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{user?.display_name ?? user?.username}</div>
            <div className="text-[10px] text-muted-foreground">{user?.role}</div>
          </div>
          <button
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="退出登录"
            onClick={() => {
              void logout()
              window.location.href = '/login'
            }}
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </aside>

      {/* 主区 */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-card px-4">
          <span className="truncate text-sm font-semibold">{activeConv ? activeConv.title : '新对话'}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modePillClass(activeConv ? activeConv.mode : draftMode)}`}>
            {MODE_LABELS[activeConv ? activeConv.mode : draftMode]}
          </span>
          {!activeConv && (
            <div className="ml-auto flex items-center gap-1">
              <span className="text-xs text-muted-foreground">模式：</span>
              {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
                <button
                  key={m}
                  className={`rounded-full px-2.5 py-0.5 text-xs ${
                    draftMode === m ? 'bg-ccnu-blue text-white' : 'text-muted-foreground hover:bg-accent'
                  }`}
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
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-card px-4 py-2">
            <span className="text-xs text-muted-foreground">内置 Skill（输入 / 唤起）：</span>
            {commands.map((c) => (
              <button
                key={c.skill}
                className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-ccnu-blue hover:text-ccnu-blue"
                title={c.description}
                onClick={() => applyCommand(c)}
              >
                /{c.command}
              </button>
            ))}
          </div>
        )}

        {/* 消息区 */}
        <div
          className={`relative min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 ${dragActive ? 'bg-ccnu-blue/5' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            if (!dragActive) setDragActive(true)
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragActive(false)
          }}
          onDrop={(e) => {
            e.preventDefault()
            setDragActive(false)
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
          }}
        >
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-ccnu-blue/10">
              <div className="rounded-xl border-2 border-dashed border-ccnu-blue bg-card px-8 py-6 text-sm font-medium text-ccnu-blue">
                📎 松开以附加文件（pdf / docx / xlsx / txt / md / csv，≤5 个）
              </div>
            </div>
          )}

          {messages.length === 0 && !streaming && (
            <div className="mx-auto mt-10 max-w-2xl">
              <div className="mb-8 text-center">
                <div className="mx-auto mb-3 flex size-16 items-center justify-center rounded-full bg-ccnu-blue/10 font-display text-3xl font-bold text-ccnu-blue">
                  华
                </div>
                <h2 className="font-display text-xl font-bold">华中师范大学 · 智能学伴</h2>
                <p className="mt-1 text-xs text-ccnu-gold-deep">求实创新 · 立德树人</p>
                <p className="mt-2 text-xs text-muted-foreground">
                  多轮对话 · 流式输出 · 输入 <code>/</code> 唤起 Skill · 生成可下载的学习文件
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {WELCOME_GUIDES.map((g) => (
                  <button
                    key={g.title}
                    className="group rounded-xl border border-border bg-card p-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-ccnu-blue/40 hover:shadow-md"
                    onClick={() => void handleSend(g.prompt)}
                  >
                    <g.icon className="mb-2 size-5 text-ccnu-blue" />
                    <div className="text-sm font-semibold">{g.title}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{g.desc}</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m) => (
            <MessageRow
              key={m.id}
              m={m}
              userName={(user?.display_name ?? user?.username ?? '我').slice(0, 1).toUpperCase()}
              onAnswer={answerAsk}
            />
          ))}

          {streaming && messages.length > 0 && !hasAnyPart(messages[messages.length - 1]) && <ThinkingIndicator />}
          {(chatError || error) && (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <span>⚠ {chatError?.message ?? error}</span>
              <button onClick={() => setError('')}>✕</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="shrink-0 border-t border-border bg-card px-4 pb-3 pt-3 sm:px-8">
          <div className="mx-auto max-w-3xl">
            {slashMenu && filteredCommands.length > 0 && (
              <div className="mb-2 overflow-hidden rounded-lg border border-border bg-card shadow-md">
                {filteredCommands.map((c) => (
                  <button
                    key={c.skill}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                    onClick={() => applyCommand(c)}
                  >
                    <span className="font-mono text-xs font-semibold text-ccnu-blue">/{c.command}</span>
                    <span className="truncate text-xs text-muted-foreground">{c.description}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 shadow-sm transition-shadow focus-within:border-ccnu-blue/50 focus-within:ring-2 focus-within:ring-ccnu-blue/20">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept=".pdf,.docx,.doc,.xlsx,.xls,.txt,.md,.csv"
                onChange={(e) => {
                  if (e.target.files) addFiles(e.target.files)
                  e.target.value = ''
                }}
              />
              <button
                className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
                onClick={() => fileInputRef.current?.click()}
                title="附加文件（pdf/docx/xlsx/txt/md/csv，可多选）"
                disabled={streaming || uploading}
              >
                <Paperclip className="size-4.5" />
              </button>
              <textarea
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={pendingAsk ? '回答助手的问题…' : '输入消息… 输入 / 唤起 Skill，Enter 发送'}
                rows={1}
                className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground"
              />
              {streaming ? (
                <Button variant="danger" size="icon" onClick={stop} title="停止生成">
                  <Square className="size-3.5" />
                </Button>
              ) : (
                <Button size="icon" onClick={() => void handleSend()} disabled={!input.trim() && pendingFiles.length === 0} title="发送">
                  <Send className="size-4" />
                </Button>
              )}
            </div>
            {(pendingFiles.length > 0 || uploading) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {pendingFiles.map((f) => (
                  <span key={`${f.name}-${f.size}`} className="flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs">
                    <FileIcon name={f.name} mime={mimeOf(f.name)} size={14} />
                    <span className="max-w-40 truncate">{f.name}</span>
                    <span className="text-muted-foreground">{fmtFileSize(f.size)}</span>
                    {!streaming && !uploading && (
                      <button className="text-muted-foreground hover:text-destructive" onClick={() => removeFile(f.name, f.size)}>
                        ✕
                      </button>
                    )}
                  </span>
                ))}
                {uploading && <span className="text-xs text-muted-foreground">⏳ 解析上传中…</span>}
              </div>
            )}
            <p className="mt-1.5 text-center text-[11px] text-muted-foreground">
              学伴 AI 生成内容仅供参考，学习请以教材与老师讲解为准。
            </p>
          </div>
        </div>
      </main>
    </div>
  )
}

function modePillClass(mode: Mode): string {
  switch (mode) {
    case 'practice':
      return 'bg-ccnu-gold/15 text-ccnu-gold-deep'
    case 'teacher':
      return 'bg-success/10 text-success'
    default:
      return 'bg-ccnu-blue/10 text-ccnu-blue'
  }
}

function hasAnyPart(m: UIMessage | undefined): boolean {
  return !!m && m.parts.length > 0
}

// ---- 单条消息渲染 ----
function MessageRow({
  m,
  userName,
  onAnswer,
}: {
  m: UIMessage
  userName: string
  onAnswer: (option: string) => void
}) {
  const parts = m.parts as unknown as {
    type: string
    text?: string
    state?: string
    data?: Record<string, unknown>
  }[]
  const isUser = m.role === 'user'

  return (
    <div className={`group mx-auto mb-4 flex max-w-3xl gap-3 ${isUser ? 'flex-row-reverse' : ''}`}>
      <div
        className={`flex size-8 shrink-0 select-none items-center justify-center rounded-full text-sm font-semibold ${
          isUser ? 'bg-muted text-foreground' : 'bg-ccnu-blue text-white'
        }`}
      >
        {isUser ? userName : '华'}
      </div>
      <div className={`min-w-0 max-w-[85%] ${isUser ? 'text-right' : 'flex-1'}`}>
        {isUser ? (
          <div className="inline-block rounded-2xl rounded-tr-sm bg-ccnu-blue px-3.5 py-2 text-left text-sm text-white shadow-sm">
            {m.parts
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('')}
          </div>
        ) : (
          <div className="rounded-2xl rounded-tl-sm border border-border bg-card px-4 py-3 shadow-sm">
            {parts.length === 0 && <ThinkingIndicator />}
            {parts.map((p, i) => {
              if (p.type === 'text') return <ChatMarkdown key={i} text={p.text ?? ''} />
              if (p.type === 'reasoning') return <ThinkingCard key={i} part={p as never} />
              if (p.type === 'data-ccnu') {
                const d = p.data as { type?: string; question?: string; options?: string[]; artifacts?: ServerMessageArtifact[] }
                if (d?.type === 'ask') return <AskCard key={i} question={d.question ?? ''} options={d.options} onAnswer={onAnswer} />
                if (d?.type === 'artifacts' && d.artifacts) return <ArtifactCards key={i} artifacts={d.artifacts} />
                return null // meta / done 静默
              }
              if (p.type.startsWith('tool-')) return <ToolCard key={i} part={p as never} />
              return null
            })}
          </div>
        )}
      </div>
    </div>
  )
}
