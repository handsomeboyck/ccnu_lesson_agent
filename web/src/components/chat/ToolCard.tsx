// 工具执行卡片：渲染 AI SDK tool part（input-available → output-available 状态机）
// 与历史消息 tool_steps（持久化轨迹）。运行中显示经过秒数 + 进度条（长任务加载态）。
import { useEffect, useState } from 'react'
import { CheckCircle2, ChevronDown, ChevronRight, Loader2, Wrench, XCircle } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { ServerMessageArtifact, ServerMessageToolStep } from '../../api/client'
import ArtifactCards from './ArtifactCards'

export interface ToolPartLike {
  type: string // tool-<name>
  toolCallId: string
  state?: string
  input?: unknown
  output?: { summary?: string; artifacts?: ServerMessageArtifact[] }
  providerExecuted?: boolean
  title?: string
}

export default function ToolCard({ part }: { part: ToolPartLike | ServerMessageToolStep }) {
  const [open, setOpen] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const isStep = 'call_id' in part || !('toolCallId' in part)
  const name = isStep ? (part as ServerMessageToolStep).name : (part as ToolPartLike).type.replace(/^tool-/, '')
  const state = isStep ? 'output-available' : ((part as ToolPartLike).state ?? 'input-available')
  const input = isStep ? undefined : (part as ToolPartLike).input
  const output = isStep ? { summary: (part as ServerMessageToolStep).summary, artifacts: (part as ServerMessageToolStep).artifacts } : (part as ToolPartLike).output

  const running = state === 'input-streaming' || state === 'input-available'
  const generating = state === 'input-streaming' // 模型正在生成调用参数
  const failed = state === 'output-error'
  const artifacts = output?.artifacts?.filter((a) => a.id || a.data) ?? []
  const hasInput = input != null && typeof input === 'object' && Object.keys(input as object).length > 0

  // 长任务加载态：运行中每秒刷新经过时间
  useEffect(() => {
    if (!running) return
    setElapsed(0)
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000)
    return () => window.clearInterval(t)
  }, [running])

  return (
    <div
      className={cn(
        'my-2 overflow-hidden rounded-lg border bg-card text-sm transition-colors',
        running ? 'border-ccnu-blue/40' : failed ? 'border-destructive/40' : 'border-border',
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-accent/60"
        onClick={() => setOpen(!open)}
      >
        {running ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-ccnu-blue" />
        ) : failed ? (
          <XCircle className="size-4 shrink-0 text-destructive" />
        ) : (
          <CheckCircle2 className="size-4 shrink-0 text-success" />
        )}
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-mono text-xs font-semibold">{name}</span>
        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          {running ? (
            <span className="inline-flex items-center gap-1 font-medium text-ccnu-blue">
              <Loader2 className="size-3 animate-spin" />
              {generating ? '正在生成调用参数…' : '执行中…'} {elapsed}s
            </span>
          ) : failed ? (
            '执行失败'
          ) : (
            output?.summary ?? '完成'
          )}
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>
      {running && (
        <div className="h-0.5 w-full overflow-hidden bg-muted">
          <div className="h-full w-1/2 animate-pulse bg-ccnu-blue/40" />
        </div>
      )}
      {open && (
        <div className="border-t bg-muted/40 px-3 py-2.5">
          {hasInput && (
            <pre className="mb-2 max-h-48 overflow-auto rounded bg-card p-2 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(input, null, 2)}
              {generating && <span className="cursor-blink">▍</span>}
            </pre>
          )}
          {output?.summary && <div className="mb-1 text-xs text-muted-foreground">{output.summary}</div>}
          {artifacts.length > 0 && <ArtifactCards artifacts={artifacts} compact />}
        </div>
      )}
    </div>
  )
}
