import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import mammoth from 'mammoth'
import { artifactIcon } from '../lib/artifactIcon'
import {
  deleteArtifact,
  fetchArtifact,
  listArtifacts,
  logout,
  type ArtifactInfo,
} from '../api/client'

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
      } else if (
        blob.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
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
    <div className="page-shell">
      <header className="page-header">
        <div>
          <h1>🗂️ 产物库</h1>
          <p className="page-sub">
            Python 沙箱 / Skill 生成的图片、CSV、文本等产物，自动保存在这里（对话内也可即时预览）。
          </p>
        </div>
        <div className="page-actions">
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

      <div className="artifact-grid">
        {items.map((a) => (
          <div key={a.id} className="artifact-tile">
            <button
              className="artifact-tile-preview"
              onClick={() => void openPreview(a)}
              title={PREVIEWABLE.some((p) => a.mime.startsWith(p)) ? `预览 ${a.filename}` : a.filename}
            >
              {a.mime.startsWith('image/') ? (
                <span className="artifact-tile-icon img">🖼</span>
              ) : (
                <span className="artifact-tile-icon other">{artifactIcon(a.filename, a.mime)}</span>
              )}
              <span className="artifact-tile-name">{a.filename}</span>
              <span className="artifact-tile-meta">
                {a.skill} · {fmtSize(a.size_bytes)}
              </span>
            </button>
            <div className="artifact-tile-actions">
              <button onClick={() => void openPreview(a)}>👁 预览</button>
              <button onClick={() => void download(a)}>⬇ 下载</button>
              <button className="danger" onClick={() => void remove(a)}>
                🗑
              </button>
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <div className="conv-empty" style={{ gridColumn: '1/-1' }}>
            暂无产物。在对话里让 AI 用 Python 画图/处理数据，生成的图片与文件会出现在这里。
          </div>
        )}
      </div>

      {preview && (
        <div className="modal-mask" onClick={closePreview}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="toolbar-title">{preview.filename}</span>
              <button onClick={closePreview}>✕</button>
            </div>
            <div className="modal-body preview-body">
              {busyPreview ? (
                <div className="preview-loading">正在加载预览…</div>
              ) : previewUrl ? (
                preview?.mime === 'application/pdf' ? (
                  <iframe src={previewUrl} title="pdf-preview" className="preview-pdf" />
                ) : (
                  <img src={previewUrl} alt={preview?.filename ?? ''} className="modal-img" />
                )
              ) : previewHtml ? (
                <div className="preview-docx" dangerouslySetInnerHTML={{ __html: previewHtml }} />
              ) : previewText ? (
                <pre className="modal-text">{previewText}</pre>
              ) : (
                <p>该类型不支持预览，可下载查看。</p>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn-primary sm" onClick={() => void download(preview)}>
                ⬇ 下载
              </button>
              <button
                className="btn-ghost"
                onClick={() => {
                  void remove(preview)
                  closePreview()
                }}
              >
                🗑 删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
