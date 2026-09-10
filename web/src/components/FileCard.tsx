// 文件输入卡片（DeepSeek Chat 风格）：
// 解析/上传中 → 图标位旋转 spinner + 「解析中...」+ 底部不确定进度条；
// 失败 → 「上传失败」+ 点击重试 + 移除；就绪 → 大写扩展名 + 大小 + hover 移除。
import FileIcon from './FileIcon'

export interface FileCardProps {
  name: string
  size: number
  /** uploading：解析/上传中（全局态，所有卡片同步展示动效）；error：解析失败；else：就绪待发送 */
  state: 'pending' | 'uploading' | 'error'
  error?: string
  onRemove: () => void
  onRetry?: () => void
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export default function FileCard({ name, size, state, error, onRemove, onRetry }: FileCardProps) {
  const ext = (name.split('.').pop() || '').toUpperCase().slice(0, 8)
  const uploading = state === 'uploading'
  const failed = state === 'error'
  return (
    <div
      className={`w-[224px] shrink-0 overflow-hidden rounded-xl border bg-card text-foreground transition-colors ${
        failed ? 'border-destructive/40' : 'border-border'
      }`}
      title={name}
    >
      <div className="flex items-center gap-2.5 px-3 py-2">
        {/* 图标位：解析中替换为 spinner */}
        <span className="flex size-9 shrink-0 items-center justify-center" aria-hidden>
          {uploading ? (
            <span className="ds-spinner" />
          ) : (
            <FileIcon name={name} mime="" size={28} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium leading-4">{name}</div>
          <div className={`truncate text-[11px] leading-4 ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
            {uploading ? (
              '解析中...'
            ) : failed ? (
              error || '上传失败'
            ) : (
              <>
                {ext.length > 0 && <span className="font-medium">{ext}</span>}
                {ext.length > 0 && <span className="mx-1">·</span>}
                {fmtSize(size)}
              </>
            )}
          </div>
        </div>
        {/* 移除：解析中隐藏（防误删正在上传的文件） */}
        {!uploading && (
          <button
            className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-destructive focus:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
            title="移除"
            aria-label="移除"
            onClick={onRemove}
          >
            ✕
          </button>
        )}
      </div>
      {/* 失败：整行可点击重试 */}
      {failed && onRetry && (
        <button
          className="block w-full border-t border-destructive/25 py-1 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10"
          onClick={onRetry}
        >
          解析失败，点击重试
        </button>
      )}
      {/* 解析中：不确定进度条（无进度报告时的 indetermi nate 动画） */}
      {uploading && (
        <div className="ds-progress-track" aria-hidden>
          <div className="ds-progress-bar" />
        </div>
      )}
    </div>
  )
}