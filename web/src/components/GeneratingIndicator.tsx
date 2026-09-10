// 正在执行中指示器：旋转 spinner（会话列表条目用，表示该会话正在生成/续流中）。
import { Loader2 } from 'lucide-react'

export default function GeneratingIndicator() {
  return (
    <span className="inline-flex shrink-0" title="正在执行中…" aria-label="正在执行中">
      <Loader2 className="size-3 animate-spin text-ccnu-blue" />
    </span>
  )
}
