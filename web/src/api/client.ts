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

export interface ServerMessageArtifact {
  id: string
  name: string
  mime: string
  /** 实时流式（SSE tool_result）额外携带 base64 data；历史回看接口不含此字段。 */
  data?: string
}
export interface ServerMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string
  artifacts?: ServerMessageArtifact[]
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

// ---- 产物库（沙箱/技能产物） ----

export interface ArtifactInfo {
  id: string
  filename: string
  mime: string
  size_bytes: number
  skill: string
  created_at: string
}

export function listArtifacts(): Promise<{ artifacts: ArtifactInfo[] }> {
  return request('/v1/artifacts', { auth: true })
}

/** 下载产物文件（鉴权后返回 blob；图片可直接 objectURL 预览）。 */
export async function fetchArtifact(id: string, download = false): Promise<Blob> {
  const { accessToken } = useAuth.getState()
  if (!accessToken) throw new ApiError(401, 'unauthorized')
  const res = await fetch(`${BASE}/v1/artifacts/${id}/raw${download ? '?download=1' : ''}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`)
  return res.blob()
}

export function deleteArtifact(id: string): Promise<void> {
  return request(`/v1/artifacts/${id}`, { method: 'DELETE', auth: true })
}

// ---- 监控（仅 admin） ----

export interface MonitorBucket {
  hour: string
  chats: number
  chat_ok: number
  chat_err: number
  prompt_tok: number
  completion: number
  duration_sum: number
  tool_calls: number
  codex_runs: number
  codex_ok: number
  asks: number
}

export interface MonitorOverview {
  generated_at: string
  uptime_sec: number
  window_hours: number
  agent: {
    chats: number
    chat_ok: number
    chat_err: number
    asks: number
    tools: number
    codex_runs: number
    codex_ok: number
    prompt_tokens: number
    completion_tokens: number
    duration_sum_ms: number
    avg_latency_ms: number
    p50_ms: number
    p95_ms: number
    by_mode: Record<string, number>
    by_skill: Record<string, number>
    buckets: MonitorBucket[]
  }
  db?: {
    available: boolean
    pg_version?: string
    db_name?: string
    connections?: number
    max_conn?: number
    db_bytes?: number
    cache_hit?: number
    commit?: number
    rollback?: number
    uptime_sec?: number
    error?: string
  }
  system?: {
    available: boolean
    error?: string
    host?: {
      hostname: string
      load_avg: number[]
      mem_total_kb: number
      mem_avail_kb: number
      cpu_cores: number
    }
    containers?: { name: string; cpu: string; mem: string; mem_perc: string }[]
  }
}

export function fetchMonitorOverview(): Promise<MonitorOverview> {
  return request('/v1/monitor/overview', { auth: true })
}

/** 统一下载入口：优先从服务器按 id 取 blob（可靠下载）；无 id 时回退 data URL。 */
export async function downloadArtifact(a: { id?: string; name: string; mime: string; data?: string }): Promise<void> {
  let blob: Blob | null = null
  if (a.id) {
    blob = await fetchArtifact(a.id, true)
  } else if (a.data) {
    const res = await fetch(`data:${a.mime};base64,${a.data}`)
    blob = res.ok ? await res.blob() : null
  }
  if (!blob) throw new ApiError(404, '产物不存在，无法下载')
  const u = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = u
  link.download = a.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(u), 5000)
}
