import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, Download, Eye, ImageIcon, LogOut, Trash2, X } from 'lucide-react'
import mammoth from 'mammoth'
import FileIcon from '../components/FileIcon'
import {
  deleteArtifact,
  fetchArtifact,
  listArtifacts,
  logout,
  type ArtifactInfo,
} from '../api/client'
import { Button } from '../components/ui/button'

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

const PREVIEWABLE = [
  'image/',
  'text/',
  'application/json',
  'text/csv',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]

export default function ArtifactsPage() {
  const [items, setItems] = useState<ArtifactInfo[]>([])
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [preview, setPreview] = useState<ArtifactInfo | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [previewHtml, setPreviewHtml] = useState('')
  const [busyPreview, setBusyPreview] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { artifacts } = await listArtifacts()
      setItems(artifacts)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function openPreview(a: ArtifactInfo) {
    try {
      setPreview(a)
      setPreviewUrl(null)
      setPreviewText('')
      setPreviewHtml('')
      setBusyPreview(true)
      const blob = await fetchArtifact(a.id)
      if (blob.type.startsWith('image/')) {
        setPreviewUrl(URL.createObjectURL(blob))
      } else if (blob.type === 'application/pdf') {
        setPreviewUrl(URL.createObjectURL(blob))
      } else if (blob.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const buf = await blob.arrayBuffer()
        const res = await mammoth.convertToHtml({ arrayBuffer: buf })
        setPreviewHtml(res.value)
      } else {
        setPreviewText((await blob.text()).slice(0, 50000))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '预览失败')
    } finally {
      setBusyPreview(false)
    }
  }

  function closePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreview(null)
    setPreviewUrl(null)
    setPreviewText('')
    setPreviewHtml('')
  }

  async function download(a: ArtifactInfo) {
    try {
      const blob = await fetchArtifact(a.id, true)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = a.filename
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败')
    }
  }

  async function remove(a: ArtifactInfo) {
    if (!window.confirm(`删除产物「${a.filename}」？`)) return
    try {
      await deleteArtifact(a.id)
      if (preview?.id === a.id) closePreview()
      await refresh()
      setInfo(`已删除 ${a.filename}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">产物库</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Python 沙箱 / Skill 生成的图片、CSV、文本等产物，自动保存在这里（对话内也可即时预览）。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/" className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="size-3.5" /> 回对话
          </Link>
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

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((a) => {
          const previewable = PREVIEWABLE.some((p) => a.mime.startsWith(p))
          return (
            <div key={a.id} className="group overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
              <button
                className="flex w-full flex-col items-center gap-2 p-4 text-left"
                onClick={() => void openPreview(a)}
                title={previewable ? `预览 ${a.filename}` : a.filename}
              >
                {a.mime.startsWith('image/') ? (
                  <span className="flex h-16 w-24 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                    <ImageIcon className="size-6" />
                  </span>
                ) : (
                  <FileIcon name={a.filename} mime={a.mime} size={44} />
                )}
                <span className="w-full truncate text-center text-xs font-medium">{a.filename}</span>
                <span className="text-[11px] text-muted-foreground">
                  {a.skill} · {fmtSize(a.size_bytes)}
                </span>
              </button>
              <div className="flex items-center justify-between border-t bg-muted/40 px-2 py-1">
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="预览"
                  onClick={() => void openPreview(a)}
                >
                  <Eye className="size-3.5" />
                </button>
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                  title="下载"
                  onClick={() => void download(a)}
                >
                  <Download className="size-3.5" />
                </button>
                <button
                  className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
                  title="删除"
                  onClick={() => void remove(a)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          )
        })}
        {items.length === 0 && (
          <div className="col-span-full py-12 text-center text-sm text-muted-foreground">
            暂无产物。在对话里让 AI 用 Python 画图/处理数据，生成的图片与文件会出现在这里。
          </div>
        )}
      </div>

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={closePreview}>
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <FileIcon name={preview.filename} mime={preview.mime} size={18} />
              <span className="truncate text-sm font-semibold">{preview.filename}</span>
              <button className="ml-auto rounded p-1 hover:bg-accent" onClick={closePreview} aria-label="关闭">
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {busyPreview ? (
                <div className="text-sm text-muted-foreground">正在加载预览…</div>
              ) : previewUrl ? (
                preview?.mime === 'application/pdf' ? (
                  <iframe src={previewUrl} title="pdf-preview" className="h-[65vh] w-full rounded border" />
                ) : (
                  <img src={previewUrl} alt={preview?.filename ?? ''} className="mx-auto max-h-[65vh] rounded object-contain" />
                )
              ) : previewHtml ? (
                <div className="preview-docx" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              ) : previewText ? (
                <pre className="whitespace-pre-wrap text-sm">{previewText}</pre>
              ) : (
                <p className="text-sm text-muted-foreground">该类型不支持预览，可下载查看。</p>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-2.5">
              <Button size="sm" variant="ghost" onClick={closePreview}>
                关闭
              </Button>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  void remove(preview)
                  closePreview()
                }}
              >
                <Trash2 className="size-3.5" /> 删除
              </Button>
              <Button size="sm" onClick={() => void download(preview)}>
                <Download className="size-3.5" /> 下载
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
