// AI SDK 协议技术探针页：验证 useChat 消费服务端
// x-vercel-ai-ui-message-stream: v1 流（start / text-* / tool-input-* / tool-output-* /
// data-ccnu / finish / [DONE]）。页面自动注册临时账号并原样 JSON 展示每条消息的 parts。
import { useEffect, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { Button } from '../components/ui/button'

const BASE = ''

async function autoLogin(): Promise<string> {
  const u = 'spike-' + Math.random().toString(36).slice(2, 10)
  const reg = await fetch(`${BASE}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
  })
  if (!reg.ok && reg.status !== 409) throw new Error(`register ${reg.status}`)
  const login = await fetch(`${BASE}/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'SpikeTest-123' }),
  })
  const j = await login.json()
  return j.access_token
}

/** 内部聊天组件：token 就绪后才挂载 useChat（v7 需显式 transport）。 */
function SpikeChat({ token }: { token: string }) {
  const [input, setInput] = useState('')
  const convIdRef = useRef('')
  const { messages, sendMessage, status, error, stop } = useChat({
    transport: new DefaultChatTransport<UIMessage>({
      api: `${BASE}/v1/chat`,
      headers: { Authorization: `Bearer ${token}` },
      body: { mode: 'companion' },
      // 适配层：SDK 的 messages[] → 本项目 API 的 {conversation_id, content, mode}
      prepareSendMessagesRequest: ({ messages: msgs, body, headers }) => {
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
        const text = (lastUser?.parts ?? [])
          .filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join('')
        return {
          api: `${BASE}/v1/chat`,
          headers,
          body: {
            conversation_id: convIdRef.current,
            content: text,
            mode: (body as { mode?: string } | undefined)?.mode ?? 'companion',
          },
        }
      },
    }),
  })
  const streaming = status === 'streaming' || status === 'submitted'

  // 从 data-ccnu meta part 里取会话 id（新会话时服务端下发）
  useEffect(() => {
    for (const m of messages) {
      for (const p of m.parts) {
        const d = (p as { type?: string; data?: unknown }).data as
          | { type?: string; conversation_id?: string }
          | undefined
        if (p.type === 'data' && d?.type === 'meta' && d.conversation_id) {
          convIdRef.current = d.conversation_id
        }
      }
    }
  }, [messages])

  function onSend() {
    const v = input.trim()
    if (!v || streaming) return
    setInput('')
    void sendMessage({ text: v })
  }

  return (
    <>
      <p className="mt-1 text-sm text-muted-foreground">
        验证 start / text-* / tool-input-* / tool-output-* / data-ccnu / finish / [DONE] 解析。
        试：<code>/quiz 2道一元二次方程</code>（工具流）或直接提问（文本流）· status={status}
      </p>
      <div className="mt-4 space-y-3">
        {messages.length === 0 && (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            发送一条消息开始
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className="rounded-lg border bg-card p-3 shadow-sm">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {m.role}
            </div>
            {m.parts.map((p, i) => (
              <pre
                key={i}
                className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono text-[11px] leading-relaxed"
              >
                {JSON.stringify(p)}
              </pre>
            ))}
          </div>
        ))}
        {streaming && <div className="text-sm text-muted-foreground">⏳ 生成中…</div>}
        {error && <div className="text-sm text-destructive">⚠ {error.message}</div>}
      </div>

      <div className="mt-4 flex gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              onSend()
            }
          }}
          placeholder="输入 /quiz 2道一元二次方程 测试工具流"
          className="h-9 flex-1 rounded-md border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        {streaming ? (
          <Button type="button" variant="danger" onClick={stop}>
            停止
          </Button>
        ) : (
          <Button type="button" onClick={onSend}>
            发送
          </Button>
        )}
      </div>
    </>
  )
}

export default function SpikePage() {
  const [token, setToken] = useState<string | null>(null)
  const [authErr, setAuthErr] = useState('')

  useEffect(() => {
    autoLogin()
      .then(setToken)
      .catch((e) => setAuthErr(e instanceof Error ? e.message : 'login failed'))
  }, [])

  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="text-xl font-bold">AI SDK 协议探针 (v7 UI message stream)</h1>
      {authErr && <div className="mt-2 text-sm text-destructive">⚠ {authErr}</div>}
      {!token && !authErr && <div className="mt-2 text-sm text-muted-foreground">登录临时账号…</div>}
      {token && <SpikeChat token={token} />}
    </div>
  )
}
