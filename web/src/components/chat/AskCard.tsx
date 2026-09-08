// 提问卡片：ask_user 内联展示（替代顶部横幅），选项点击即答。
import { HelpCircle } from 'lucide-react'
import { Button } from '../ui/button'

export default function AskCard({
  question,
  options,
  onAnswer,
}: {
  question: string
  options?: string[]
  onAnswer: (option: string) => void
}) {
  return (
    <div className="my-2 rounded-lg border border-ccnu-gold/40 bg-ccnu-gold/5 p-3.5">
      <div className="flex items-start gap-2.5">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-ccnu-gold-deep" />
        <div className="min-w-0">
          <div className="mb-0.5 text-xs font-semibold text-ccnu-gold-deep">学伴想先确认一个问题</div>
          <div className="text-sm">{question}</div>
        </div>
      </div>
      {options && options.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {options.map((o) => (
            <Button
              key={o}
              type="button"
              variant="outline"
              size="sm"
              data-ask-option
              onClick={() => onAnswer(o)}
            >
              {o}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
