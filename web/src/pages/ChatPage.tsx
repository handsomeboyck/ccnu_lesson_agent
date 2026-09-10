// ChatPage v3：自研流式引擎（useChatStream）——正常发送 / 断点续流 / 权威兜底统一处理。
// 消息渲染基于 parts（text / reasoning / tool-* / data-ccnu），四类卡片：
// 思考卡（ThinkingCard）、工具卡（ToolCard）、产物卡（ArtifactCards）、提问卡（AskCard）。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Link } from 'react-router-dom'
import {
  Activity,
  ExternalLink,
  FolderOpen,
  GraduationCap,
  Library,
  LogOut,
  NotebookPen,
  Paperclip,
  PenLine,
  Plus,
  Puzzle,
  Search,
  Send,
  Square,
  Trash2,
  Pencil,
  MoreHorizontal,
  Loader2,
  PanelLeftOpen,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  deleteConversation,
  listConversations,
  listGenerating,
  listMessages,
  listSkills,
  logout,
  renameConversation,
  stopChat,
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
import MobileTabBar from '../components/MobileTabBar'
import GeneratingIndicator from '../components/GeneratingIndicator'
import { useChatStream, type ChatStreamMessage } from '../lib/useChatStream'
import type { CcnnPart } from '../lib/streamMerge'

// ---- 常量与工具 ----

const WELCOME_GUIDES = [
  {
    icon: Puzzle,
    title: '诊断教学设计',
    desc: '诊断物理教学设计中的问题与改进方向',
    prompt: '/diagnose 帮我诊断物理教学设计问题',
  },
  {
    icon: GraduationCap,
    title: '理论研修',
    desc: '结合最近发展区理论设计物理教学过程',
    prompt: '/theory 帮我讲讲怎么设计物理教学过程符合最近发展区',
  },
  {
    icon: NotebookPen,
    title: '课堂设问',
    desc: '围绕物理概念出题，促进学生思维',
    prompt: '/quiz 帮我按照物理概念教学，出课上的2个问题，促进学生思维，围绕电场强度概念',
  },
  {
    icon: Search,
    title: '教学研究检索',
    desc: '检索物理教学模式与方法的相关资料',
    prompt: '/search 如何在实验教学中运用物理教学模式和方法',
  },
]

// 会话模式图标（lucide 组件，替代 emoji）
const MODE_ICONS: Record<string, LucideIcon> = {
  companion: GraduationCap,
  practice: NotebookPen,
  teacher: PenLine,
}

/** 历史消息（REST）→ 消息 parts（与流式渲染同一套 parts 模型）。 */
function historyToMessages(msgs: ServerMessage[]): ChatStreamMessage[] {
  return msgs.map((m) => {
    const parts: CcnnPart[] = []
    if (m.role === 'assistant') {
      // 思考链（发生顺序：思考 → 工具 → 文本）
      if (m.reasoning) {
        parts.push({ type: 'reasoning', id: 'r1', text: m.reasoning, state: 'done' })
      }
      for (const [i, t] of (m.tool_steps ?? []).entries()) {
        parts.push({
          type: `tool-${t.name}`,
          toolCallId: t.call_id ?? `hist-${i}`,
          state: 'output-available',
          output: { summary: t.summary },
          providerExecuted: true,
        })
      }
      if (m.artifacts && m.artifacts.length > 0) {
        parts.push({ type: 'data-ccnu', data: { type: 'artifacts', artifacts: m.artifacts } })
      }
      // ask_user 触发时的提问卡（历史回看重建 AskCard）
      if (m.ask && m.ask.question) {
        parts.push({ type: 'data-ccnu', data: { type: 'ask', question: m.ask.question, options: m.ask.options ?? [] } })
      }
    }
    parts.push({ type: 'text', text: m.content })
    return { id: m.id, role: m.role === 'user' ? 'user' : 'assistant', parts }
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
  const [mobileMenu, setMobileMenu] = useState(false) // 移动端头部 ⋯ 菜单
  const [mobileConvOpen, setMobileConvOpen] = useState(false) // 移动端历史会话面板
  const [isMobile, setIsMobile] = useState(false) // 移动端断点（占位符等按设备分流）

  const convIdRef = useRef('')
  const modeRef = useRef<string>('companion')
  const attachRef = useRef<string[]>([])
  const sendingRef = useRef(false) // 同步发送锁：防止双击/连发产生并发流（会破坏 SDK 消息列表）
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null) // 消息区滚动容器
  const stickRef = useRef(true)                   // 是否贴底：贴底才自动跟随，用户上滑则停手
  const fileInputRef = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null) // 输入框（自动增高）
  const lastConvRef = useRef<string | null>(null) // 上次打开的会话（刷新恢复）
  const restoredRef = useRef(false)               // 是否已执行过会话恢复
  const convLoadedRef = useRef(false)             // 会话列表是否已加载完成
  const activeConv = conversations.find((c) => c.id === activeId) ?? null

  // ---- Resume Streams：会话的 streamId 映射（localStorage 持久化，刷新不丢）----
  const streamMapRef = useRef<Record<string, string>>({}) // convId → streamId

  // 初始化：从 localStorage 恢复 streamMap
  useEffect(() => {
    try {
      streamMapRef.current = JSON.parse(localStorage.getItem('ccnu-stream-map') || '{}')
    } catch {
      streamMapRef.current = {}
    }
  }, [])

  // 清理某会话的 streamMap 记录
  const clearStream = useCallback((convId: string) => {
    if (streamMapRef.current[convId]) {
      delete streamMapRef.current[convId]
      localStorage.setItem('ccnu-stream-map', JSON.stringify(streamMapRef.current))
    }
  }, [])

  // ---- 自研流式引擎（发送 / 断点续流 / 权威兜底统一）----
  const {
    messages,
    setMessages,
    status: chatStatus,
    error: chatError,
    bgGenerating,
    setBgGenerating,
    sendMessage: streamSend,
    resume: streamResume,
    stop: streamStop,
  } = useChatStream({
    onMeta: ({ conversationId, streamId }) => {
      // 会话 id 回传 + streamMap 持久化（直接用 meta 数据做 key，
      // 修复旧实现"meta 先于 convIdRef 赋值导致映射丢失"的竞态）
      convIdRef.current = conversationId
      streamMapRef.current[conversationId] = streamId
      localStorage.setItem('ccnu-stream-map', JSON.stringify(streamMapRef.current))
      setActiveId((prev) => (prev && prev !== conversationId ? prev : conversationId))
      void refreshConversations()
    },
    onDone: () => {
      void refreshConversations()
    },
  })
  const streaming = chatStatus === 'streaming'

  // ---- 正在执行的会话集合（侧栏"正在执行中"动画）----
  // 数据源：后端 /v1/chat/generating（权威，覆盖切走/刷新后的后台生成）+ 本地当前流即时并入
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set())
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const { generating } = await listGenerating()
        if (!alive) return
        setGeneratingIds(new Set(generating.map((g) => g.conversation_id)))
      } catch {
        // 静默：轮询失败保持上次状态
      }
    }
    void refresh()
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh() // 页面不可见时暂停轮询
    }, 5000)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [])
  // 某会话是否正在执行：后端集合 ∪ 当前本地流（即时，避免 5s 轮询延迟）
  const isExecuting = (id: string) => generatingIds.has(id) || (streaming && convIdRef.current === id)

  // 权威兜底：问后端"该会话是否在生成"，是则轮询 DB 直到 assistant 回复出现（最长 ~15min）
  const fallbackWatch = useCallback(
    async (convId: string) => {
      try {
        const { generating } = await listGenerating()
        if (!generating.some((g) => g.conversation_id === convId)) return
      } catch {
        return
      }
      if (convIdRef.current === convId) setBgGenerating(true)
      for (let attempt = 0; attempt < 450; attempt++) {
        try {
          const { messages: msgs } = await listMessages(convId)
          const lastMsg = msgs[msgs.length - 1]
          if (lastMsg?.role === 'assistant' && (lastMsg.content || lastMsg.ask)) {
            if (convIdRef.current === convId) {
              setMessages(historyToMessages(msgs))
              requestAnimationFrame(() => {
                const el = scrollRef.current
                if (el) el.scrollTop = el.scrollHeight
              })
            }
            break
          }
        } catch {
          // 单次失败继续轮询
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (convIdRef.current === convId) setBgGenerating(false)
    },
    [setMessages],
  )

  // 打开会话后的恢复：优先真续流；无断点状态/续流失败 → 权威兜底。
  // 两者均幂等（无断点状态立即返回 / 不在生成列表立即返回），
  // 因此不做"已恢复"去重——生成中切走再切回也需重新恢复展示。
  const restoreStream = useCallback(
    async (convId: string) => {
      const resumed = await streamResume({
        convId,
        listMessages: async (cid) => (await listMessages(cid)).messages,
        toMessages: historyToMessages,
        // 断点状态缺失时退化为纯重放续流（meta 曾回传过该会话的 streamId）
        fallbackStreamId: streamMapRef.current[convId],
      })
      if (!resumed) await fallbackWatch(convId)
    },
    [streamResume, fallbackWatch],
  )

  // 停止生成：本地断流（清断点）+ 显式通知后端终止后台任务（唯一真正的"断开"）
  const stopGeneration = useCallback(() => {
    const convID = convIdRef.current
    streamStop()
    if (convID) {
      void stopChat(convID).catch(() => {})
      clearStream(convID)
    }
  }, [streamStop, clearStream])

  // ---- 初始化（含刷新恢复：会话 + 草稿）----
  useEffect(() => {
    const last = localStorage.getItem('ccnu-last-conv')
    lastConvRef.current = last && last !== '' ? last : null
    const draft = localStorage.getItem('ccnu-last-draft')
    if (draft) setInput(draft)
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
      convLoadedRef.current = true
    } catch {
      // 静默
    }
  }, [])

  const openConversation = useCallback(
    async (id: string) => {
      // 切换会话 ≠ 断开：仅暂停本地流（保留断点，切回可续流）；后端 genCtx 继续生成并落库
      if (streaming) streamStop(true)
      setBgGenerating(false) // 打开会话重置横幅：不继承上一个会话的"后台生成中"状态
      stickRef.current = true // 打开会话 → 跟随到底
      setActiveId(id)
      setError('')
      const conv = conversations.find((c) => c.id === id)
      if (conv) modeRef.current = conv.mode
      try {
        const { messages: msgs } = await listMessages(id)
        convIdRef.current = id
        attachRef.current = []
        setMessages(historyToMessages(msgs))
        requestAnimationFrame(() => {
          const el = scrollRef.current
          if (el) el.scrollTop = el.scrollHeight
        })
        // 恢复：优先真续流；无断点状态/续流失败 → 权威兜底轮询
        void restoreStream(id)
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载消息失败')
      }
    },
    [conversations, streaming, streamStop, setMessages, restoreStream, setBgGenerating],
  )

  // 刷新后自动恢复上次打开的会话（等会话列表真正加载完成再消费，避免竞态）
  useEffect(() => {
    if (restoredRef.current || !convLoadedRef.current || conversations.length === 0) return
    const id = lastConvRef.current
    if (id && conversations.some((c) => c.id === id)) {
      restoredRef.current = true
      void openConversation(id)
    } else if (!id) {
      restoredRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, openConversation])

  // 记忆当前会话与输入草稿（刷新不丢；activeId 为空时不覆盖，避免清空上次会话记录）
  useEffect(() => {
    if (activeId) localStorage.setItem('ccnu-last-conv', activeId)
  }, [activeId])
  useEffect(() => {
    localStorage.setItem('ccnu-last-draft', input)
  }, [input])

  // 移动端断点检测（占位符等按设备分流）
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)')
    const on = () => setIsMobile(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const newChat = useCallback(() => {
    if (streaming) stopGeneration()
    setBgGenerating(false) // 新对话重置横幅（不继承任何会话的"后台生成中"残留）
    stickRef.current = true // 新对话 → 跟随到底
    setActiveId(null)
    setError('')
    convIdRef.current = ''
    attachRef.current = []
    setMessages([])
    setPendingFiles([])
    modeRef.current = draftMode
  }, [streaming, stopGeneration, setMessages, draftMode, setBgGenerating])

  // 流结束/出错后解锁发送（chatStatus 异步更新，配合 sendingRef 同步锁）
  useEffect(() => {
    if (chatStatus === 'ready' || chatStatus === 'error') sendingRef.current = false
  }, [chatStatus])

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
    void streamSend({
      text: option,
      displayText: option,
      convId: convIdRef.current,
      mode: modeRef.current,
      attachments: [],
      listMessages: async (cid) => (await listMessages(cid)).messages,
      toMessages: historyToMessages,
    })
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
    stickRef.current = true // 主动发送 → 恢复贴底跟随

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
    if (taRef.current) taRef.current.style.height = 'auto' // 发送后收起输入框
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
    stickRef.current = true
    void streamSend({
      text: content || (attachIds.length > 0 ? '请阅读我上传的文件并给出简要总结。' : ''),
      displayText: display,
      convId: convIdRef.current,
      mode: modeRef.current,
      attachments: attachIds,
      listMessages: async (cid) => (await listMessages(cid)).messages,
      toMessages: historyToMessages,
    })
    // 主动发送 → 强制滚到底（不依赖滚动事件时序）
    requestAnimationFrame(() => {
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    })
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
    autoGrowTa()
  }
  // 输入框随内容自动增高（打字时不再僵硬地固定单行高度）
  function autoGrowTa() {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
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

  // ---- 自动滚动（贴底才跟随：用户上滑读历史时停手，回到底部或主动发送后恢复）----
  const STICK_THRESHOLD = 120 // 距底部小于该像素视为"贴底"
  const onMessagesScroll = () => {
    const el = scrollRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
  }
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickRef.current) return
    // 实时读位置（同步，避免 scroll 事件异步导致的竞态）：已上滑则不跟随并停手
    if (el.scrollHeight - el.scrollTop - el.clientHeight > STICK_THRESHOLD * 2) {
      stickRef.current = false
      return
    }
    el.scrollTop = el.scrollHeight // 瞬时定位，避免流式 chunk 的 smooth 抖动
  }, [messages, chatStatus])

  // ---- 渲染 ----
  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
      {/* 侧栏（桌面 lg+ 显示；移动端用底部导航） */}
      <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-card lg:flex">
        <div className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ccnu-blue font-display text-lg font-bold text-white shadow-sm">
            华
          </div>
          <div className="min-w-0">
            <div className="truncate font-display text-sm font-bold">华中师范大学</div>
            <div className="text-[11px] text-muted-foreground">智能助教</div>
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
            <FolderOpen className="size-4" /> 我的文件
          </Link>
          {user?.role !== 'student' && (
            <Link to="/skills" className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <Puzzle className="size-4" /> 学习功能
            </Link>
          )}
          {user?.role === 'admin' && (
            <Link to="/monitor" className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              <Activity className="size-4" /> 运行监控
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
                    <span className="text-xs text-muted-foreground">
                      {(() => {
                        const Icon = MODE_ICONS[c.mode]
                        return Icon ? <Icon className="size-3.5" /> : <span>💬</span>
                      })()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {isExecuting(c.id) && <GeneratingIndicator />}
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
          <a
            href="https://github.com/handsomeboyck/ccnu_lesson_agent"
            target="_blank"
            rel="noreferrer"
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="开源仓库 · GitHub"
          >
            <ExternalLink className="size-4" />
          </a>
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
          {/* 移动端：历史会话入口 */}
          <button
            className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
            onClick={() => setMobileConvOpen(true)}
            title="历史会话"
            aria-label="历史会话"
          >
            <PanelLeftOpen className="size-5" />
          </button>
          <span className="truncate text-sm font-semibold">{activeConv ? activeConv.title : '新对话'}</span>
          <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${modePillClass(activeConv ? activeConv.mode : draftMode)}`}>
            {MODE_LABELS[activeConv ? activeConv.mode : draftMode]}
          </span>
          {/* 模式切换（桌面右上角；移动端收进 ⋯ 菜单） */}
          {!activeConv && (
            <div className="ml-auto hidden items-center gap-0.5 rounded-lg bg-muted p-0.5 lg:flex">
              {(Object.keys(MODE_LABELS) as Mode[]).map((m) => {
                const Icon = MODE_ICONS[m]
                const active = draftMode === m
                return (
                  <button
                    key={m}
                    onClick={() => setDraftMode(m)}
                    title={MODE_LABELS[m]}
                    className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-all ${
                      active
                        ? 'bg-ccnu-blue text-white shadow-sm ring-2 ring-ccnu-blue/30'
                        : 'text-muted-foreground hover:bg-card hover:text-foreground'
                    }`}
                  >
                    {Icon && <Icon className="size-3.5" />}
                    {MODE_LABELS[m]}
                  </button>
                )
              })}
            </div>
          )}
          {/* 移动端 ⋯ 菜单（模式/监控/仓库/退出） */}
          <div className="relative ml-auto lg:hidden">
            <button
              onClick={() => setMobileMenu((v) => !v)}
              className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
              title="更多"
              aria-label="更多"
            >
              <MoreHorizontal className="size-5" />
            </button>
            {mobileMenu && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMobileMenu(false)} />
                <div className="absolute right-0 top-full z-40 mt-1 w-44 rounded-lg border border-border bg-card p-1 shadow-lg">
                  {!activeConv && (
                    <div className="px-2 py-1.5">
                      <div className="mb-1 px-1 text-[11px] text-muted-foreground">模式</div>
                      <div className="flex flex-col gap-0.5">
                        {(Object.keys(MODE_LABELS) as Mode[]).map((m) => {
                          const Icon = MODE_ICONS[m]
                          return (
                            <button
                              key={m}
                              onClick={() => {
                                setDraftMode(m)
                                setMobileMenu(false)
                              }}
                              className={`flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                                draftMode === m
                                  ? 'bg-ccnu-blue/10 font-medium text-ccnu-blue'
                                  : 'text-foreground hover:bg-accent'
                              }`}
                            >
                              {Icon && <Icon className="size-4" />}
                              {MODE_LABELS[m]}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )}
                  {user?.role === 'admin' && (
                    <Link
                      to="/monitor"
                      onClick={() => setMobileMenu(false)}
                      className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-accent"
                    >
                      <Activity className="size-4" /> 运行监控
                    </Link>
                  )}
                  <a
                    href="https://github.com/handsomeboyck/ccnu_lesson_agent"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-foreground hover:bg-accent"
                  >
                    <ExternalLink className="size-4" /> 开源仓库
                  </a>
                  <button
                    onClick={() => {
                      setMobileMenu(false)
                      void logout()
                      window.location.href = '/login'
                    }}
                    className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-destructive hover:bg-accent"
                  >
                    <LogOut className="size-4" /> 退出登录
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        {/* 快捷功能面板（新对话时） */}
        {!activeConv && commands.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border bg-card px-4 py-2">
            <span className="text-xs text-muted-foreground">快捷功能（输入 / 唤起）：</span>
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
          ref={scrollRef}
          onScroll={onMessagesScroll}
          className={`relative min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-8 ${dragActive ? 'bg-ccnu-blue/5' : ''} ${
            messages.length === 0 && !streaming ? 'flex items-center justify-center' : ''
          }`}
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
                <Paperclip className="mr-1.5 inline size-4" />
                松开以附加文件（PDF / Word / Excel / 文本，最多 5 个）
              </div>
            </div>
          )}

          {messages.length === 0 && !streaming && (
            <div className="mx-auto w-full max-w-2xl">
              <div className="mb-5 text-center">
                <div className="mx-auto mb-3 flex size-12 items-center justify-center rounded-full bg-ccnu-blue/10 font-display text-xl font-bold text-ccnu-blue">
                  华
                </div>
                <h2 className="font-display text-lg font-bold">华中师范大学 · 智能助教</h2>
                <p className="mt-1 text-xs text-ccnu-gold-deep">求实创新 · 立德树人</p>
                <p className="mt-1.5 text-xs text-muted-foreground">
                  多轮对话、实时回复、输入 <code>/</code> 唤起快捷功能、生成可下载的学习文件
                </p>
              </div>
              {/* 灵犀式：输入框上方一排快捷功能胶囊（点击填入输入框，可修改后发送） */}
              <div className="flex flex-wrap items-center justify-center gap-2">
                {WELCOME_GUIDES.map((g) => (
                  <button
                    key={g.title}
                    title={`${g.desc}（点击填入输入框，可修改后发送）`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-[#E5E6EB] bg-white px-3 py-1.5 text-xs text-[#333] transition-colors hover:border-ccnu-blue/50 hover:text-ccnu-blue"
                    onClick={() => {
                      setInput(g.prompt)
                      setSlashMenu(false)
                      taRef.current?.focus()
                    }}
                  >
                    <g.icon className="size-3.5" />
                    {g.title}
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
          {bgGenerating && !streaming && (
            <div className="mx-auto mt-3 flex w-fit items-center gap-2 rounded-full border border-ccnu-blue/30 bg-ccnu-blue/5 px-3 py-1.5 text-xs text-ccnu-blue-deep">
              <Loader2 className="size-3.5 animate-spin" />
              正在后台生成中…完成后自动显示
            </div>
          )}
          {(chatError || error) && (
            <div className="mt-3 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <span>⚠ {chatError || error}</span>
              <button onClick={() => setError('')}>✕</button>
            </div>
          )}          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div className="shrink-0 border-t border-border bg-card px-4 pb-[calc(env(safe-area-inset-bottom)+3.75rem)] pt-3 sm:px-8 lg:pb-3">
          <div className="relative mx-auto max-w-3xl">
            {slashMenu && filteredCommands.length > 0 && (
              // 悬浮于输入框上方（不挤动上方内容），白底+柔和阴影与输入框同族
              <div className="absolute inset-x-0 bottom-full z-20 mb-2 overflow-hidden rounded-xl border border-border bg-white shadow-[0_6px_20px_rgba(20,35,60,0.1)]">
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
            {/* 聚焦不显示高亮矩形/光环，只保留光标（用户明确要求） */}
            <div className="flex items-end gap-2 rounded-[20px] border border-border bg-white p-2 shadow-[0_1px_3px_rgba(20,35,60,0.06)]">
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
                title="附加文件（PDF / Word / Excel / 文本，可多选）"
                disabled={streaming || uploading}
              >
                <Paperclip className="size-4.5" />
              </button>
              <textarea
                ref={taRef}
                value={input}
                onChange={(e) => onInputChange(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder={
                  pendingAsk
                    ? '回答助手的问题…'
                    : isMobile
                      ? '输入消息…'
                      : '输入消息… 输入 / 唤起快捷功能，Enter 发送'
                }
                rows={1}
                className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none caret-ccnu-blue transition-[height] duration-150 placeholder:text-muted-foreground"
              />
              {streaming ? (
                <Button variant="danger" size="icon" onClick={stopGeneration} title="停止生成">
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
              智能助教生成内容仅供参考，学习请以教材与老师讲解为准。
            </p>
          </div>
        </div>
      </main>
      </div>
      {/* 移动端历史会话面板 */}
      {mobileConvOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-card lg:hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ccnu-blue font-display text-sm font-bold text-white">
              华
            </div>
            <div className="text-sm font-bold">历史会话</div>
            <Button
              size="sm"
              className="ml-auto"
              onClick={() => {
                newChat()
                setMobileConvOpen(false)
              }}
            >
              <Plus className="size-4" /> 新对话
            </Button>
            <button
              className="rounded p-1.5 text-muted-foreground hover:bg-accent"
              onClick={() => setMobileConvOpen(false)}
              aria-label="关闭"
            >
              <X className="size-5" />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {groupByDay(conversations).map((g) => (
              <div key={g.label} className="mb-2">
                <div className="px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{g.label}</div>
                {g.items.map((c) => (
                  <div
                    key={c.id}
                    className={`flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-sm ${
                      c.id === activeId
                        ? 'bg-ccnu-blue/10 text-ccnu-blue-deep'
                        : 'text-foreground hover:bg-accent'
                    }`}
                    onClick={() => {
                      void openConversation(c.id)
                      setMobileConvOpen(false)
                    }}
                  >
                    <span className="text-muted-foreground">
                      {(() => {
                        const Icon = MODE_ICONS[c.mode]
                        return Icon ? <Icon className="size-4" /> : <span>💬</span>
                      })()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    {isExecuting(c.id) && <GeneratingIndicator />}
                    <span className="flex shrink-0 gap-1">
                      <button
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                        title="重命名"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleRename(c)
                        }}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                      <button
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          void handleDelete(c)
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {conversations.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">暂无历史会话</div>
            )}
          </div>
        </div>
      )}
      {/* 移动端底部导航 */}
      <MobileTabBar />
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

function hasAnyPart(m: ChatStreamMessage | undefined): boolean {
  return !!m && m.parts.length > 0
}

// ---- 单条消息渲染 ----
function MessageRow({
  m,
  userName,
  onAnswer,
}: {
  m: ChatStreamMessage
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
        {isUser ? userName : '艺'}
      </div>
      <div className={`min-w-0 ${isUser ? 'max-w-[85%] text-right' : 'flex-1'}`}>
        {isUser ? (
          // 用户消息：浅灰胶囊（灵犀风格——克制，不抢眼）
          <div className="inline-block rounded-2xl rounded-tr-md bg-[#F2F3F5] px-4 py-2 text-left text-[15px] leading-relaxed text-[#1D1D1F]">
            {m.parts
              .filter((p) => p.type === 'text')
              .map((p) => (p as { text: string }).text)
              .join('')}
          </div>
        ) : (
          // 助手消息：去气泡化文本流（灵犀风格——像文档，不包卡片）
          <div className="min-w-0">
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
