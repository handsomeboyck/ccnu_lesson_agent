// 产物回看：每类产物一张卡片。
// - 图片：缩略图 + 点击放大
// - docx：卡片预览 → mammoth 渲染正文（网页内预览）
// - pdf ：卡片预览 → 内嵌 PDF 查看器（iframe + blob）
// - 文本类（csv/txt/md/json/html）：预览原文
// - pptx/xlsx 等：展示为文件卡片，可下载（浏览器不支持内嵌预览）
// 卡片同时常驻「下载」按钮（优先服务器 blob，保证可靠下载）。
import { useEffect, useState } from 'react'
import mammoth from 'mammoth'
import { downloadArtifact, fetchArtifact, type ServerMessageArtifact } from '../api/client'
import { artifactIcon } from '../lib/artifactIcon'

/** 拉取产物原始内容：优先内嵌 data（实时产物），否则按 id 拉取。 */
async function fetchBytes(a: ServerMessageArtifact): Promise<Blob> {
  if (typeof a.data === 'string' && a.data.length > 0) {
    // 文本原样（后端 text 明文）；二进制 base64
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

function useImageSrc(a: ServerMessageArtifact) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  const hasData = typeof a.data === 'string' && a.data.length > 0
  useEffect(() => {
    if (hasData || !a.id) {
      setBlobUrl(null)
      return
    }
    let alive = true
    let obj: string | null = null
    setBlobUrl(null)
    setError('')
    fetchArtifact(a.id)
      .then((blob) => {
        if (!alive) return
        obj = URL.createObjectURL(blob)
        setBlobUrl(obj)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : '加载失败'))
    return () => {
      alive = false
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [a.id, hasData])
  const src = hasData
    ? a.mime.startsWith('text/')
      ? ''
      : `data:${a.mime};base64,${a.data}`
    : blobUrl
  return { src, error }
}

interface PreviewState {
  artifact: ServerMessageArtifact
  kind: 'loading' | 'html' | 'pdf' | 'text' | 'image'
  url?: string
  html?: string
  text?: string
  err?: string
}

export default function HistoryArtifacts({ artifacts }: { artifacts: ServerMessageArtifact[] }) {
  if (!artifacts || artifacts.length === 0) return null
  const [preview, setPreview] = useState<PreviewState | null>(null)

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
        const url = URL.createObjectURL(blob)
        setPreview({ artifact: a, kind: 'image', url })
      } else if (a.mime === 'application/pdf') {
        const url = URL.createObjectURL(blob)
        setPreview({ artifact: a, kind: 'pdf', url })
      } else if (
        a.mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        const buf = await blob.arrayBuffer()
        const res = await mammoth.convertToHtml({ arrayBuffer: buf })
        setPreview({
          artifact: a,
          kind: 'html',
          html: res.value,
          err: res.messages.length ? res.messages.map((m) => m.message).join('；') : undefined,
        })
      } else if (a.mime.startsWith('text/')) {
        setPreview({ artifact: a, kind: 'text', text: await blob.text() })
      } else {
        setPreview(null)
        await downloadArtifact(a)
      }
    } catch (e) {
      setPreview({
        artifact: a,
        kind: 'text',
        err: e instanceof Error ? e.message : '预览失败',
        text: '',
      })
    }
  }

  return (
    <div className="hist-artifacts">
      <div className="hist-artifacts-title">📎 生成的文件（点击卡片预览 / 下载）</div>
      <div className="hist-artifacts-grid">
        {artifacts.map((a) => (
          <ArtifactCard key={a.id} a={a} onPreview={() => void openPreview(a)} />
        ))}
      </div>
      {preview && (
        <div className="modal-mask" onClick={closePreview}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="toolbar-title">
                {artifactIcon(preview.artifact.name, preview.artifact.mime)} 预览：
                {preview.artifact.name}
              </span>
              <button onClick={closePreview}>✕</button>
            </div>
            <div className="modal-body preview-body">
              {preview.kind === 'loading' && <div className="preview-loading">正在加载预览…</div>}
              {preview.kind === 'image' && preview.url && (
                <img src={preview.url} alt="" className="modal-img" />
              )}
              {preview.kind === 'pdf' && preview.url && (
                <iframe src={preview.url} title="pdf-preview" className="preview-pdf" />
              )}
              {preview.kind === 'html' && (
                <div
                  className="preview-docx"
                  dangerouslySetInnerHTML={{ __html: preview.html ?? '' }}
                />
              )}
              {preview.kind === 'text' && (
                <pre className="modal-text">{preview.text || preview.err || ''}</pre>
              )}
            </div>
            <div className="modal-foot">
              {preview.kind !== 'loading' && (
                <button
                  className="btn-primary sm"
                  onClick={() => void downloadArtifact(preview.artifact)}
                >
                  ⬇ 下载
                </button>
              )}
              <button className="btn-ghost" onClick={closePreview}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function ArtifactCard({ a, onPreview }: { a: ServerMessageArtifact; onPreview: () => void }) {
  const isImage = a.mime.startsWith('image/')
  const { src, error } = useImageSrc(a)
  const [downloading, setDownloading] = useState(false)
  const previewable = isPreviewable(a)

  async function download() {
    try {
      setDownloading(true)
      await downloadArtifact(a)
    } catch {
      // ignore
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="artifact-card">
      {isImage ? (
        <button className="artifact-card-thumb" onClick={onPreview} title="点击放大预览">
          {src ? <img src={src} alt={a.name} /> : <span>加载中…</span>}
        </button>
      ) : (
        <button
          className="artifact-card-icon"
          onClick={previewable ? onPreview : () => void download()}
          title={previewable ? '点击预览' : '点击下载'}
        >
          <span className="artifact-card-emoji">{artifactIcon(a.name, a.mime)}</span>
          <span className="artifact-card-name">{a.name}</span>
        </button>
      )}
      <div className="artifact-card-meta">
        <span className="artifact-card-actions">
          {previewable && (
            <button className="hist-artifact-dl" onClick={onPreview}>
              👁 预览
            </button>
          )}
          <button className="hist-artifact-dl" onClick={() => void download()} disabled={downloading}>
            {downloading ? '下载中…' : '⬇ 下载'}
          </button>
        </span>
      </div>
      {error && <span className="hist-artifact-err">⚠ {error}</span>}
    </div>
  )
}
