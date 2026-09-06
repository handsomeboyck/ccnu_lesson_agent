import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  deleteLibraryFile,
  listLibrary,
  logout,
  uploadLibraryFile,
  type LibraryFile,
} from '../api/client'

const ACCEPT = '.pdf,.docx,.doc,.xlsx,.txt,.md,.csv'
const POLL_MS = 2000
const POLL_MAX = 30

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function LibraryPage() {
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const pollRef = useRef<number | null>(null)

  const refresh = useCallback(async () => {
    try {
      const { files: list } = await listLibrary()
      setFiles(list)
      return list.some((f) => f.status === 'parsing')
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
      return false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    async function boot() {
      if (await refresh()) {
        // 有解析中的文件 → 轮询
        let n = 0
        pollRef.current = window.setInterval(async () => {
          n++
          if (n >= POLL_MAX || cancelled) {
            if (pollRef.current) window.clearInterval(pollRef.current)
            return
          }
          await refresh()
        }, POLL_MS)
      }
    }
    void boot()
    return () => {
      cancelled = true
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [refresh])

  async function pickFiles(ev: React.ChangeEvent<HTMLInputElement>) {
    const list = Array.from(ev.target.files ?? [])
    ev.target.value = '' // 允许重复选择同一文件
    if (list.length === 0) return
    setUploading(true)
    setError('')
    setInfo('')
    try {
      for (const f of list) {
        await uploadLibraryFile(f)
      }
      setInfo(`已上传 ${list.length} 个文件，正在解析…`)
      await refresh()
      // 启动轮询直到解析完成
      let n = 0
      if (pollRef.current) window.clearInterval(pollRef.current)
      pollRef.current = window.setInterval(async () => {
        n++
        if (n >= POLL_MAX) {
          if (pollRef.current) window.clearInterval(pollRef.current)
          return
        }
        await refresh()
      }, POLL_MS)
    } catch (err) {
      setError(err instanceof Error ? err.message : '上传失败')
    } finally {
      setUploading(false)
    }
  }

  async function remove(f: LibraryFile) {
    if (!window.confirm(`删除「${f.filename}」？其解析内容将一并移除，对话中将无法再检索到。`)) return
    try {
      await deleteLibraryFile(f.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <h1>📚 我的资料库</h1>
          <p className="page-sub">
            上传 pdf / docx / xlsx / txt，自动解析并建立索引。对话中问「根据我上传的资料…」即可检索引用（带出处）。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn-primary sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? '上传中…' : '＋ 上传文件'}
          </button>
          <Link to="/" className="btn-ghost">
            ← 回对话
          </Link>
          <button
            className="btn-ghost"
            onClick={() => {
              void logout()
              window.location.href = '/login'
            }}
          >
            ⎋ 退出
          </button>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden onChange={pickFiles} />
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <span>⚠ {error}</span>
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}
      {info && (
        <div className="info-banner">
          <span>✓ {info}</span>
          <button onClick={() => setInfo('')}>✕</button>
        </div>
      )}

      <div className="file-table">
        <div className="file-row head">
          <span className="col-name">文件名</span>
          <span className="col-size">大小</span>
          <span className="col-status">状态</span>
          <span className="col-time">上传时间</span>
          <span className="col-op" />
        </div>
        {files.map((f) => (
          <div key={f.id} className="file-row">
            <span className="col-name" title={f.filename}>
              <span className="file-icon">{iconOf(f.ext)}</span>
              {f.filename}
            </span>
            <span className="col-size">{fmtSize(f.size_bytes)}</span>
            <span className="col-status">
              {f.status === 'ready' && <span className="tag doc">✓ 已就绪</span>}
              {f.status === 'parsing' && <span className="status-spin">⏳ 解析中…</span>}
              {f.status === 'failed' && (
                <span className="status-fail" title={f.error}>
                  ✗ 失败
                </span>
              )}
            </span>
            <span className="col-time">{new Date(f.created_at).toLocaleString()}</span>
            <span className="col-op">
              <button title="删除" onClick={() => void remove(f)}>
                🗑
              </button>
            </span>
          </div>
        ))}
        {files.length === 0 && !uploading && (
          <div className="conv-empty">资料库为空。上传一份讲义/课件/表格试试：对话里就能引用它。</div>
        )}
      </div>
    </div>
  )
}

function iconOf(ext: string): string {
  switch (ext) {
    case 'pdf':
      return '📕'
    case 'docx':
    case 'doc':
      return '📘'
    case 'xlsx':
      return '📗'
    default:
      return '📄'
  }
}
