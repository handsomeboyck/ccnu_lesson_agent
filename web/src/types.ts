// 共享类型定义（与 server 端 JSON 契约对应，见 Agent.md §5/§6）

export type Role = 'student' | 'teacher' | 'admin'
export type Mode = 'companion' | 'practice' | 'teacher'
export type MessageRole = 'user' | 'assistant' | 'tool'

export interface User {
  id: string
  username: string
  display_name: string
  role: Role
  created_at: string
}

export interface Conversation {
  id: string
  title: string
  mode: Mode
  course_id: string
  created_at: string
  updated_at: string
}

export interface ChatMessage {
  id: string
  role: MessageRole
  content: string
  created_at: string
}

export interface TokenPair {
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number
  user: User
}

export interface SSEEvent {
  event: string
  data: string
}

// / 命令入口（对应 server /v1/skills 的 commands）
export interface CommandInfo {
  skill: string
  command: string
  aliases: string[]
  description: string
  parameters?: Record<string, unknown>
}

// ask 事件载荷
export interface AskPayload {
  question: string
  options?: string[]
}

export const MODE_LABELS: Record<Mode, string> = {
  companion: '学伴',
  practice: '练习测评',
  teacher: '教师辅助',
}
