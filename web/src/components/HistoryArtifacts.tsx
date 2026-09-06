// 产物回看：带 data（实时流式产物）即时显示；否则按 artifact id 鉴权拉取 raw。
// 每项提供常驻"下载"按钮（优先服务器 blob，保证可靠下载）。
import { useEffect, useState } from 'react'
import { downloadArtifact, fetchArtifact, type ServerMessageArtifact } from '../api/client'

/** 图片自动拉取 raw（仅当没有内嵌 data 时）；data 已给则直接 data URL 即时渲染。 */
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
  const src = hasData ? `data:${a.mime};base64,${a.data}` : blobUrl
  return { src, error, hasData }
}

export default function HistoryArtifacts({ artifacts }: { artifacts: ServerMessageArtifact[] }) {
  if (!artifacts || artifacts.length === 0) return null
  return (
    <div className="hist-artifacts">
      {artifacts.map((a) => (
        <ArtifactItem key={a.id} a={a} />
      ))}
    </div>
  )
}

function ArtifactItem({ a }: { a: ServerMessageArtifact }) {
  const isImage = a.mime.startsWith('image/')
  const { src, error, hasData } = useImageSrc(a)
  const [open, setOpen] = useState(false)
  const [downloading, setDownloading] = useState(false)

  async function download() {
    try {
      setDownloading(true)
      await downloadArtifact(a)
    } catch {
      // 忽略
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className="hist-artifact">
      {isImage ? (
        <>
          {src ? (
            <img
              className="hist-artifact-thumb"
              src={src}
              alt={a.name}
              onClick={() => setOpen(true)}
              title={`点击放大 ${a.name}`}
            />
          ) : (
            <div className="hist-artifact-thumb loading">加载中…</div>
          )}
          <div className="hist-artifact-meta">
            <span className="hist-artifact-name">📎 {a.name}</span>
            {(a.id || a.data) && (
              <button className="hist-artifact-dl" onClick={() => void download()} disabled={downloading}>
                {downloading ? '下载中…' : '⬇ 下载'}
              </button>
            )}
          </div>
          {open && src && (
            <div className="modal-mask" onClick={() => setOpen(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <span className="toolbar-title">{a.name}</span>
                  <button onClick={() => setOpen(false)}>✕</button>
                </div>
                <div className="modal-body">
                  <img src={src} alt={a.name} className="modal-img" />
                </div>
                <div className="modal-foot">
                  <button className="btn-primary sm" onClick={() => void download()}>
                    ⬇ 下载
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <button
          className="artifact-file"
          onClick={() => void download()}
          title={`下载 ${a.name}`}
          disabled={downloading}
        >
          📄 {a.name}（{downloading ? '下载中…' : '点击下载'}）
        </button>
      )}
      {error && <span className="hist-artifact-err">⚠ {error}</span>}
      {/* 无 id 且无 data 的非图片产物兜底说明 */}
      {!isImage && !hasData && !a.id && (
        <span className="hist-artifact-err">⚠ 该产物缺少下载源</span>
      )}
    </div>
  )
}
