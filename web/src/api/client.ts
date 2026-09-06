// REST API 客户端：自动附带 Bearer token；401 时用 refresh token 静默续期后重试一次。
import { useAuth } from '../store/auth'
import type { Conversation, TokenPair, User } from '../types'

const BASE = import.meta.env.VITE_API_BASE ?? ''

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  auth?: boolean
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function rawRequest<T>(path: string, opts: RequestOptions, token?: string): Promise<T> {
  const headers: Record<string, string> = {}
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch {
      // 忽略非 JSON 响应体
    }
    throw new ApiError(res.status, msg)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

let refreshing: Promise<boolean> | null = null

/** 用 refresh token 换取新令牌，成功则写回 store。 */
async function doRefresh(): Promise<boolean> {
  const { refreshToken, setAuth, clear } = useAuth.getState()
  if (!refreshToken) return false
  try {
    const pair = await rawRequest<TokenPair>('/v1/auth/refresh', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    })
    setAuth(pair)
    return true
  } catch {
    clear()
    return false
  }
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { accessToken } = useAuth.getState()
  if (!opts.auth) return rawRequest<T>(path, opts)

  if (!accessToken) throw new ApiError(401, 'unauthorized')
  try {
    return await rawRequest<T>(path, opts, accessToken)
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401) throw err
    // 并发请求共享一次刷新
    refreshing ??= doRefresh().finally(() => {
      refreshing = null
    })
    const ok = await refreshing
    if (!ok) throw err
    const newToken = useAuth.getState().accessToken
    return rawRequest<T>(path, opts, newToken ?? undefined)
  }
}

// ---- 认证 ----

export function register(payload: {
  username: string
  password: string
  display_name?: string
  role?: string
}): Promise<User> {
  return rawRequest<User>('/v1/auth/register', { method: 'POST', body: payload })
}

export function login(username: string, password: string): Promise<TokenPair> {
  return rawRequest<TokenPair>('/v1/auth/login', {
    method: 'POST',
    body: { username, password },
  })
}

export async function logout(): Promise<void> {
  const { refreshToken } = useAuth.getState()
  try {
    await rawRequest('/v1/auth/logout', {
      method: 'POST',
      body: { refresh_token: refreshToken },
    })
  } finally {
    useAuth.getState().clear()
  }
}

export function me(): Promise<User> {
  return request<User>('/v1/auth/me', { auth: true })
}

// ---- 会话 ----

export function listConversations(): Promise<{ conversations: Conversation[] }> {
  return request('/v1/conversations', { auth: true })
}

export function createConversation(payload: { title?: string; mode?: string; course_id?: string }): Promise<Conversation> {
  return request('/v1/conversations', { method: 'POST', body: payload, auth: true })
}

export function renameConversation(id: string, title: string): Promise<Conversation> {
  return request(`/v1/conversations/${id}`, { method: 'PATCH', body: { title }, auth: true })
}

export function deleteConversation(id: string): Promise<void> {
  return request(`/v1/conversations/${id}`, { method: 'DELETE', auth: true })
}

export interface ServerMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  created_at: string
}

export function listMessages(conversationId: string): Promise<{ messages: ServerMessage[] }> {
  return request(`/v1/conversations/${conversationId}/messages`, { auth: true })
}

// ---- Skills ----

export interface SkillInfo {
  name: string
  description: string
  modes: string[]
}

export function listSkills(): Promise<{ skills: SkillInfo[] }> {
  return request('/v1/skills', { auth: true })
}
