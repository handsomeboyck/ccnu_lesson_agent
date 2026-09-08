// 思考卡片：AI 推理过程折叠展示（R1 reasoning part 通道已预留）。
import { useState } from 'react'
import { Brain, ChevronDown, ChevronRight } from 'lucide-react'

export interface ReasoningPartLike {
  type: string
  id?: string
  text: string
  state?: string
}

export function ThinkingCard({ part }: { part: ReasoningPartLike }) {
  const [open, setOpen] = useState(false)
  const streaming = part.state === 'streaming'
  return (
    <div className="my-2 rounded-lg border border-border bg-muted/50 text-sm">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground hover:bg-accent/60"
        onClick={() => setOpen(!open)}
      >
        <Brain className="size-3.5 text-ccnu-gold-deep" />
        <span className="text-xs font-medium">{streaming ? '正在思考…' : '思考过程'}</span>
        <span className="ml-auto">{open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}</span>
      </button>
      {open && (
        <div className="border-t px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">{part.text}</div>
      )}
    </div>
  )
}

/** 流式等待指示：助手已受理、尚无任何 part 时显示。 */
export function ThinkingIndicator() {
  return (
    <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ccnu-blue opacity-60" />
        <span className="relative inline-flex size-2 rounded-full bg-ccnu-blue" />
      </span>
      <span className="text-xs">学伴思考中…</span>
    </div>
  )
}
