// 历史消息产物回看：根据 artifact id 鉴权拉取 raw 并展示（图片缩略/可下载）。
import { useEffect, useState } from 'react'
import { fetchArtifact, type ServerMessageArtifact } from '../api/client'

function useBlobUrl(id: string, enabled: boolean) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!enabled) return
    let alive = true
    let obj: string | null = null
    setUrl(null)
    setError('')
    fetchArtifact(id)
      .then((blob) => {
        if (!alive) return
        obj = URL.createObjectURL(blob)
        setUrl(obj)
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : '加载失败'))
    return () => {
      alive = false
      if (obj) URL.revokeObjectURL(obj)
    }
  }, [id, enabled])
  return { url, error }
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
  const { url, error } = useBlobUrl(a.id, isImage) // 图片才自动拉取
  const [open, setOpen] = useState(false)

  async function download() {
    try {
      const blob = await fetchArtifact(a.id, true)
      const u = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = u
      link.download = a.name
      document.body.appendChild(link)
      link.click()
      link.remove()
      setTimeout(() => URL.revokeObjectURL(u), 5000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="hist-artifact">
      {isImage ? (
        <>
          <img
            className="hist-artifact-thumb"
            src={url ?? undefined}
            alt={a.name}
            onClick={() => setOpen(true)}
            title={`点击放大 ${a.name}`}
          />
          {open && url && (
            <div className="modal-mask" onClick={() => setOpen(false)}>
              <div className="modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                  <span className="toolbar-title">{a.name}</span>
                  <button onClick={() => setOpen(false)}>✕</button>
                </div>
                <div className="modal-body">
                  <img src={url} alt={a.name} className="modal-img" />
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
        <button className="artifact-file" onClick={() => void download()} title={`下载 ${a.name}`}>
          📄 {a.name}（点击下载）
        </button>
      )}
      {error && <span className="hist-artifact-err">⚠ {error}</span>}
    </div>
  )
}
