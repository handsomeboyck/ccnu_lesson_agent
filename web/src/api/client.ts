// REST API 客户端：自动附带 Bearer token；401 时用 refresh token 静默续期后重试一次。
import { useAuth } from '../store/auth'
import type { Conversation, TokenPair, User } from '../types'

const BASE = import.meta.env.VITE_API_BASE ?? ''

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
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

// ---- Skills & Commands ----

export interface SkillInfo {
  name: string
  description: string
  modes: string[]
  commands?: string[]
  doc?: boolean
  primitive?: boolean
}

export interface CommandInfo {
  skill: string
  command: string
  aliases: string[]
  description: string
}

export function listSkills(): Promise<{ skills: SkillInfo[]; commands: CommandInfo[] }> {
  return request('/v1/skills', { auth: true })
}

export interface SkillDetail {
  name: string
  description: string
  commands: string[]
  modes: string[]
  files: string[]
  content: string
}

export function getSkillDetail(name: string): Promise<SkillDetail> {
  return request(`/v1/skills/${name}`, { auth: true })
}

export function saveSkill(name: string, content: string): Promise<{ name: string }> {
  return request(`/v1/skills/${name}`, { method: 'PUT', body: { content }, auth: true })
}

export function deleteSkill(name: string): Promise<void> {
  return request(`/v1/skills/${name}`, { method: 'DELETE', auth: true })
}

// ---- 用户资料库 ----

export interface LibraryFile {
  id: string
  filename: string
  ext: string
  size_bytes: number
  status: 'parsing' | 'ready' | 'failed'
  error: string
  created_at: string
}

export function listLibrary(): Promise<{ files: LibraryFile[] }> {
  return request('/v1/library/files', { auth: true })
}

/** 上传文件（multipart）。返回上传的元数据；解析在服务端异步进行。 */
export async function uploadLibraryFile(file: File): Promise<LibraryFile> {
  const { accessToken } = useAuth.getState()
  if (!accessToken) throw new ApiError(401, 'unauthorized')
  const form = new FormData()
  form.append('file', file)
  const res = await fetch(`${BASE}/v1/library/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const body = (await res.json()) as { error?: string }
      if (body.error) msg = body.error
    } catch {
      // ignore
    }
    throw new ApiError(res.status, msg)
  }
  return (await res.json()) as LibraryFile
}

export function deleteLibraryFile(id: string): Promise<void> {
  return request(`/v1/library/files/${id}`, { method: 'DELETE', auth: true })
}
