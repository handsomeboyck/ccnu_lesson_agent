import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  ArrowLeft,
  Download,
  Eye,
  FolderOpen,
  ImageIcon,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { renderAsync } from '@novet/docx-preview'
import * as XLSX from 'xlsx'
import FileIcon from '../components/FileIcon'
import {
  deleteArtifact,
  fetchArtifact,
  listArtifacts,
  type ArtifactInfo,
} from '../api/client'
import { Button, buttonVariants } from '../components/ui/button'
import MobileTabBar from '../components/MobileTabBar'

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
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]

/** 文件类型徽章配色。 */
function extBadge(name: string): { label: string; cls: string } {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'pdf':
      return { label: 'PDF', cls: 'bg-red-50 text-red-600 border-red-200' }
    case 'docx':
    case 'doc':
      return { label: 'DOC', cls: 'bg-blue-50 text-blue-600 border-blue-200' }
    case 'xlsx':
    case 'xls':
    case 'csv':
      return { label: 'SHEET', cls: 'bg-emerald-50 text-emerald-600 border-emerald-200' }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return { label: 'IMG', cls: 'bg-purple-50 text-purple-600 border-purple-200' }
    case 'pptx':
    case 'ppt':
      return { label: 'PPT', cls: 'bg-orange-50 text-orange-600 border-orange-200' }
    default:
      return { label: (ext || 'FILE').toUpperCase().slice(0, 6), cls: 'bg-muted text-muted-foreground border-border' }
  }
}

/** 图片缩略图：拉取 blob → objectURL（复用产物卡逻辑）。 */
function ThumbImg({ a }: { a: ArtifactInfo }) {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let alive = true
    let obj: string | null = null
    fetchArtifact(a.id)
      .then((blob) => {
        if (!alive) return
        obj = URL.createObjectURL(blob)
        setSrc(obj)
      })
      .catch(() => alive && setErr(true))
    return () => {
      alive = false
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [a.id])
  if (err) return <ImageIcon className="size-6 text-muted-foreground" />
  if (!src) return <ImageIcon className="size-6 animate-pulse text-muted-foreground" />
  return <img src={src} alt={a.filename} className="h-full w-full object-cover" />
}

export default function ArtifactsPage() {
  const [items, setItems] = useState<ArtifactInfo[]>([])
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<ArtifactInfo | null>(null)
  const [previewKind, setPreviewKind] = useState<'image' | 'pdf' | 'docx' | 'html' | 'xlsx' | 'text' | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewText, setPreviewText] = useState('')
  const [previewHtml, setPreviewHtml] = useState('')
  const [busyPreview, setBusyPreview] = useState(false)
  const docxEl = useRef<HTMLDivElement | null>(null)

  // docx：docx-preview 需要真实 DOM 容器，渲染区挂载后异步渲染
  useEffect(() => {
    if (previewKind !== 'docx' || !preview) return
    let alive = true
    void (async () => {
      try {
        const blob = await fetchArtifact(preview.id)
        if (!alive || !docxEl.current) return
        docxEl.current.innerHTML = ''
        await renderAsync(blob, docxEl.current, undefined, { className: 'docx-preview-inner' })
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'docx 预览失败')
      } finally {
        if (alive) setBusyPreview(false)
      }
    })()
    return () => { alive = false }
  }, [previewKind, preview])

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

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter((a) => a.filename.toLowerCase().includes(q) || (a.skill ?? '').toLowerCase().includes(q))
  }, [items, search])

  async function openPreview(a: ArtifactInfo) {
    try {
      setPreview(a)
      setPreviewUrl(null)
      setPreviewText('')
      setPreviewHtml('')
      setBusyPreview(true)
      const blob = await fetchArtifact(a.id)
      const name = a.filename.toLowerCase()
      if (blob.type.startsWith('image/')) {
        setPreviewKind('image')
        setPreviewUrl(URL.createObjectURL(blob))
      } else if (blob.type === 'application/pdf') {
        setPreviewKind('pdf')
        setPreviewUrl(URL.createObjectURL(blob))
      } else if (blob.type.includes('html') || name.endsWith('.html') || name.endsWith('.htm')) {
        // HTML：iframe srcDoc 直接渲染网页效果（sandbox 隔离，不执行脚本）
        setPreviewKind('html')
        setPreviewHtml(await blob.text())
      } else if (blob.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) {
        // docx：docx-preview 渲染到容器（版式保真：表格/图片/样式）
        setPreviewKind('docx')
      } else if (blob.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || name.endsWith('.xlsx') || name.endsWith('.xls')) {
        // xlsx：SheetJS 解析 → HTML 表格
        const wb = XLSX.read(await blob.arrayBuffer(), { type: 'array' })
        const first = wb.SheetNames[0]
        setPreviewKind('xlsx')
        setPreviewHtml(first ? XLSX.utils.sheet_to_html(wb.Sheets[first]) : '<p>（无工作表）</p>')
      } else {
        setPreviewKind('text')
        setPreviewText((await blob.text()).slice(0, 50000))
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '预览失败')
      setBusyPreview(false)
    }
  }

  function closePreview() {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
    setPreview(null)
    setPreviewKind(null)
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
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-8 lg:pb-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">我的文件</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AI 生成的图片和文件会自动保存在这里，对话中也能随时查看。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/chat" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <ArrowLeft className="size-3.5" /> 回对话
          </Link>
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

      {/* 工具栏：搜索 + 计数 */}
      {items.length > 0 && (
        <div className="mb-4 flex items-center gap-3">
          <div className="flex max-w-xs flex-1 items-center gap-2 rounded-md border border-input bg-card px-2.5">
            <Search className="size-4 shrink-0 text-muted-foreground" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索文件名 / 技能…"
              className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <span className="ml-auto text-xs text-muted-foreground">
            共 {filtered.length} 个 / {items.length}
          </span>
        </div>
      )}

      {filtered.length === 0 && items.length > 0 ? (
        <div className="rounded-xl border border-dashed border-border py-14 text-center text-sm text-muted-foreground">
          没有匹配「{search}」的产物
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card py-16 text-center">
          <FolderOpen className="mx-auto mb-3 size-10 text-muted-foreground/50" />
          <div className="text-sm font-medium">这里还没有产物</div>
          <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
            在对话里让 AI 画图、处理数据，或生成 Word / PPT / PDF 试卷和课件，文件会自动出现在这里。
          </p>
          <Link to="/chat" className={buttonVariants({ variant: 'default', size: 'sm', className: 'mt-4' })}>
            去对话生成
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {filtered.map((a) => {
            const previewable = PREVIEWABLE.some((p) => a.mime.startsWith(p))
            const isImage = a.mime.startsWith('image/')
            const badge = extBadge(a.filename)
            return (
              <div
                key={a.id}
                className="group overflow-hidden rounded-lg border border-border bg-card transition-colors hover:border-ccnu-blue/30"
              >
                <button
                  className="flex w-full flex-col text-left"
                  onClick={() => void openPreview(a)}
                  title={previewable ? `预览 ${a.filename}` : a.filename}
                >
                  <div className="relative flex h-28 items-center justify-center overflow-hidden bg-muted/60">
                    {isImage ? (
                      <ThumbImg a={a} />
                    ) : (
                      <FileIcon name={a.filename} mime={a.mime} size={40} />
                    )}
                    <span className={`absolute left-2 top-2 rounded border px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1 px-3 pb-2 pt-2.5">
                    <span className="truncate text-xs font-medium">{a.filename}</span>
                    <span className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span className="truncate">{a.skill}</span>
                      <span className="shrink-0">
                        {fmtSize(a.size_bytes)} · {new Date(a.created_at).toLocaleDateString()}
                      </span>
                    </span>
                  </div>
                </button>
                <div className="flex items-center justify-end gap-0.5 border-t bg-muted/40 px-2 py-1">
                  {previewable && (
                    <button
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="预览"
                      onClick={() => void openPreview(a)}
                    >
                      <Eye className="size-3.5" />
                    </button>
                  )}
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
        </div>
      )}

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
              ) : previewKind === 'docx' ? (
                <div ref={docxEl} className="docx-preview-box" />
              ) : previewKind === 'html' ? (
                <iframe
                  srcDoc={previewHtml}
                  sandbox=""
                  title="html-preview"
                  className="h-[65vh] w-full rounded border bg-white"
                />
              ) : previewKind === 'xlsx' ? (
                <div className="xlsx-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              ) : previewKind === 'image' || previewKind === 'pdf' ? (
                previewKind === 'pdf' ? (
                  <iframe src={previewUrl ?? undefined} title="pdf-preview" className="h-[65vh] w-full rounded border" />
                ) : (
                  <img src={previewUrl ?? undefined} alt={preview?.filename ?? ''} className="mx-auto max-h-[65vh] rounded object-contain" />
                )
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
      <MobileTabBar />
    </div>
  )
}
