// Markdown 渲染（复用既有 .markdown-body 样式）+ 消息复制按钮。
// 数学公式：remark-math + rehype-katex（教学场景 $...$ / $$...$$ 渲染为 KaTeX）。
import { useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { Check, Copy } from 'lucide-react'

export default function ChatMarkdown({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  function copy() {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="markdown-body min-w-0">
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
        {text}
      </ReactMarkdown>
      <button
        type="button"
        className="mt-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
        onClick={copy}
        title="复制消息"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {copied ? '已复制' : '复制'}
      </button>
    </div>
  )
}
