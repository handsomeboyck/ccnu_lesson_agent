// 断点续流状态持久化（localStorage）。
// 真正的续流逻辑在 useChatStream（发送/续流共用同一流引擎）；本模块只负责
// 「刷新点状态」的读写：未完成消息的 parts（含中间状态）+ 已消费到的最大 seq。
export const RESUME_STORAGE_KEY = 'ccnu-stream-resume'

export interface StreamResumeState {
  convId: string
  streamId: string
  lastSeq: number
  parts: import('./streamMerge').CcnnPart[]
  updatedAt: number
}

export function loadResume(): StreamResumeState | null {
  try {
    const raw = localStorage.getItem(RESUME_STORAGE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as StreamResumeState
    if (!s || typeof s.convId !== 'string' || typeof s.streamId !== 'string' || !Array.isArray(s.parts)) return null
    return s
  } catch {
    return null
  }
}

export function saveResume(s: StreamResumeState | null) {
  try {
    if (s) localStorage.setItem(RESUME_STORAGE_KEY, JSON.stringify(s))
    else localStorage.removeItem(RESUME_STORAGE_KEY)
  } catch {
    // 忽略 localStorage 异常（隐私模式等）
  }
}
