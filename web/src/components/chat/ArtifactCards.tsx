// 产物卡片：图片缩略图 / 文件图标卡 + 预览（docx mammoth / pdf iframe / 文本）+ 下载。
import { useEffect, useState } from 'react'
import { Download, Eye, FileText, ImageIcon, Paperclip, X } from 'lucide-react'
import mammoth from 'mammoth'
import { downloadArtifact, fetchArtifact, type ServerMessageArtifact } from '../../api/client'
import FileIcon from '../FileIcon'
import { Button } from '../ui/button'
import { cn } from '../../lib/utils'

async function fetchBytes(a: ServerMessageArtifact): Promise<Blob> {
  if (typeof a.data === 'string' && a.data.length > 0) {
    if (a.mime.startsWith('text/')) return new Blob([a.data], { type: a.mime })
    const bin = atob(a.data)
    const u8 = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i)
    return new Blob([u8], { type: a.mime })
  }
  return fetchArtifact(a.id)
}

function isPreviewable(a: ServerMessageArtifact): boolean {
  return (
    a.mime.startsWith('image/') ||
    a.mime === 'application/pdf' ||
    a.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    a.mime.startsWith('text/')
  )
}

export default function ArtifactCards({
  artifacts,
  compact = false,
}: {
  artifacts: ServerMessageArtifact[]
  compact?: boolean
}) {
  const [preview, setPreview] = useState<{
    artifact: ServerMessageArtifact
    kind: 'loading' | 'html' | 'pdf' | 'text' | 'image'
    url?: string
    html?: string
    text?: string
    err?: string
  } | null>(null)

  function closePreview() {
    setPreview((p) => {
      if (p?.url) URL.revokeObjectURL(p.url)
      return null
    })
  }

  async function openPreview(a: ServerMessageArtifact) {
    setPreview({ artifact: a, kind: 'loading' })
    try {
      const blob = await fetchBytes(a)
      if (a.mime.startsWith('image/')) {
        setPreview({ artifact: a, kind: 'image', url: URL.createObjectURL(blob) })
      } else if (a.mime === 'application/pdf') {
        setPreview({ artifact: a, kind: 'pdf', url: URL.createObjectURL(blob) })
      } else if (a.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const res = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() })
        setPreview({ artifact: a, kind: 'html', html: res.value })
      } else if (a.mime.startsWith('text/')) {
        setPreview({ artifact: a, kind: 'text', text: await blob.text() })
      } else {
        setPreview(null)
        await downloadArtifact(a)
      }
    } catch (e) {
      setPreview({ artifact: a, kind: 'text', err: e instanceof Error ? e.message : '预览失败', text: '' })
    }
  }

  if (!artifacts || artifacts.length === 0) return null

  return (
    <div className="mt-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Paperclip className="size-3" /> 生成的文件
      </div>
      <div className={cn('grid gap-2', compact ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4')}>
        {artifacts.map((a) => (
          <ArtifactCard key={a.id || a.name} a={a} onPreview={() => void openPreview(a)} />
        ))}
      </div>
      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" onClick={closePreview}>
          <div
            className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b px-4 py-2.5">
              <FileIcon name={preview.artifact.name} mime={preview.artifact.mime} size={18} />
              <span className="truncate text-sm font-semibold">{preview.artifact.name}</span>
              <button className="ml-auto rounded p-1 hover:bg-accent" onClick={closePreview} aria-label="关闭">
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              {preview.kind === 'loading' && <div className="text-sm text-muted-foreground">正在加载预览…</div>}
              {preview.kind === 'image' && preview.url && (
                <img src={preview.url} alt="" className="mx-auto max-h-[65vh] rounded object-contain" />
              )}
              {preview.kind === 'pdf' && preview.url && (
                <iframe src={preview.url} title="pdf-preview" className="h-[65vh] w-full rounded border" />
              )}
              {preview.kind === 'html' && (
                <div className="preview-docx" dangerouslySetInnerHTML={{ __html: preview.html ?? '' }} />
              )}
              {preview.kind === 'text' && (
                <pre className="whitespace-pre-wrap text-sm">{preview.text || preview.err || ''}</pre>
              )}
            </div>
            <div className="flex justify-end gap-2 border-t px-4 py-2.5">
              <Button size="sm" variant="ghost" onClick={closePreview}>
                关闭
              </Button>
              <Button size="sm" onClick={() => void downloadArtifact(preview.artifact)}>
                <Download className="size-3.5" /> 下载
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ArtifactCard({ a, onPreview }: { a: ServerMessageArtifact; onPreview: () => void }) {
  const isImage = a.mime.startsWith('image/')
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [imgErr, setImgErr] = useState('')
  const [downloading, setDownloading] = useState(false)
  const previewable = isPreviewable(a)
  const hasData = typeof a.data === 'string' && a.data.length > 0

  useEffect(() => {
    if (hasData || !a.id || !isImage) return
    let alive = true
    let obj: string | null = null
    fetchArtifact(a.id)
      .then((blob) => {
        if (!alive) return
        obj = URL.createObjectURL(blob)
        setBlobUrl(obj)
      })
      .catch((e) => alive && setImgErr(e instanceof Error ? e.message : '加载失败'))
    return () => {
      alive = false
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [a.id, hasData, isImage])

  const src = hasData ? `data:${a.mime};base64,${a.data}` : blobUrl

  return (
    <div className="group overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-shadow hover:shadow-md">
      <button
        type="button"
        className={cn('flex w-full items-center gap-2 p-2.5 text-left', !isImage && 'h-16')}
        onClick={previewable ? onPreview : () => void downloadArtifact(a)}
        title={previewable ? '点击预览' : '点击下载'}
      >
        {isImage ? (
          <div className="flex h-16 w-20 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
            {src ? (
              <img src={src} alt={a.name} className="h-full w-full object-cover" />
            ) : imgErr ? (
              <FileText className="size-5 text-muted-foreground" />
            ) : (
              <ImageIcon className="size-5 animate-pulse text-muted-foreground" />
            )}
          </div>
        ) : (
          <FileIcon name={a.name} mime={a.mime} size={28} />
        )}
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.name}</span>
      </button>
      <div className="flex items-center justify-between border-t bg-muted/40 px-2 py-1">
        <span className="pl-0.5 text-[10px] text-muted-foreground">{previewable ? '可预览' : '文件'}</span>
        <span className="flex gap-0.5">
          {previewable && (
            <button className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground" title="预览" onClick={onPreview}>
              <Eye className="size-3.5" />
            </button>
          )}
          <button
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            title="下载"
            disabled={downloading}
            onClick={() => {
              setDownloading(true)
              void downloadArtifact(a).finally(() => setDownloading(false))
            }}
          >
            <Download className="size-3.5" />
          </button>
        </span>
      </div>
    </div>
  )
}
