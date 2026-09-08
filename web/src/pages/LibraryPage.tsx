import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, CheckCircle2, Loader2, LogOut, Trash2, Upload, XCircle } from 'lucide-react'
import {
  deleteLibraryFile,
  listLibrary,
  logout,
  uploadLibraryFile,
  type LibraryFile,
} from '../api/client'
import FileIcon from '../components/FileIcon'
import MobileTabBar from '../components/MobileTabBar'
import { Button } from '../components/ui/button'

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
    ev.target.value = ''
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
    <div className="mx-auto max-w-5xl px-6 pb-24 pt-8 lg:pb-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">我的资料库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            上传 PDF / Word / Excel / 文本文件，AI 会自动读取内容。对话中问「根据我上传的资料…」，AI 会基于资料作答并注明出处。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="size-3.5" /> {uploading ? '上传中…' : '上传文件'}
          </Button>
          <Button size="sm" variant="ghost" className="[&_svg]:size-3.5">
            <Link to="/" className="inline-flex items-center gap-1.5">
              <ArrowLeft /> 回对话
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void logout()
              window.location.href = '/login'
            }}
          >
            <LogOut className="size-3.5" /> 退出
          </Button>
          <input ref={fileRef} type="file" multiple accept={ACCEPT} hidden onChange={pickFiles} />
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>⚠ {error}</span>
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}
      {info && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          <span>✓ {info}</span>
          <button onClick={() => setInfo('')}>✕</button>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <div className="hidden grid-cols-[minmax(0,1fr)_90px_110px_160px_40px] items-center gap-2 border-b border-border bg-muted/50 px-4 py-2.5 text-xs font-medium text-muted-foreground sm:grid">
          <span>文件名</span>
          <span>大小</span>
          <span>状态</span>
          <span>上传时间</span>
          <span />
        </div>
        {files.map((f) => (
          <div
            key={f.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 px-4 py-2.5 text-sm last:border-0 hover:bg-accent/40 sm:grid sm:grid-cols-[minmax(0,1fr)_90px_110px_160px_40px] sm:gap-2"
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 sm:block" title={f.filename}>
              <FileIcon name={f.filename} mime={`application/${f.ext}`} size={16} />
              <span className="truncate">{f.filename}</span>
              {/* 移动端：大小并入文件名行 */}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground sm:hidden">
                {fmtSize(f.size_bytes)}
              </span>
            </span>
            <span className="hidden text-xs text-muted-foreground sm:block">{fmtSize(f.size_bytes)}</span>
            <span>
              {f.status === 'ready' && (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                  <CheckCircle2 className="size-3" /> 已就绪
                </span>
              )}
              {f.status === 'parsing' && (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> 解析中…
                </span>
              )}
              {f.status === 'failed' && (
                <span className="inline-flex items-center gap-1 text-xs text-destructive" title={f.error}>
                  <XCircle className="size-3" /> 失败
                </span>
              )}
            </span>
            <span className="hidden text-xs text-muted-foreground sm:block">
              {new Date(f.created_at).toLocaleString()}
            </span>
            <span className="ml-auto flex shrink-0 justify-end sm:ml-0">
              <button
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                title="删除"
                onClick={() => void remove(f)}
              >
                <Trash2 className="size-4" />
              </button>
            </span>
          </div>
        ))}
        {files.length === 0 && !uploading && (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            资料库为空。上传一份讲义/课件/表格试试：对话里就能引用它。
          </div>
        )}
      </div>
      <MobileTabBar />
    </div>
  )
}
