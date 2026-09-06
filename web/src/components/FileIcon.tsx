// FileIcon —— WPS/Office 风格彩色文件图标（SVG）。
// 彩色圆角方块 + 左上白色文档折角 + 居中类型缩写，接近 WPS/Office 文件图标观感。
interface FileIconProps {
  name: string
  mime: string
  size?: number // 渲染宽度（px），默认 44
}

interface Kind {
  color: string
  label: string
  textSize: number
  mono?: boolean
}

function kindFor(name: string, mime: string): Kind {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (mime === 'application/pdf' || ext === 'pdf') {
    return { color: '#e5473c', label: 'PDF', textSize: 13 } // 红
  }
  switch (ext) {
    case 'docx':
    case 'doc':
      return { color: '#2b6cb8', label: 'W', textSize: 24 } // 文字蓝
    case 'pptx':
    case 'ppt':
      return { color: '#e8782c', label: 'P', textSize: 24 } // 演示橙
    case 'xlsx':
    case 'xls':
      return { color: '#1e9e4f', label: 'X', textSize: 24 } // 表格绿
    case 'csv':
      return { color: '#2f9e6e', label: 'CSV', textSize: 10 }
    case 'txt':
      return { color: '#607d9b', label: 'TXT', textSize: 9 }
    case 'md':
      return { color: '#5b6cbf', label: 'MD', textSize: 11, mono: true }
    case 'json':
      return { color: '#b58a28', label: '{}', textSize: 12, mono: true }
    case 'html':
      return { color: '#dd7a1b', label: '<>', textSize: 10, mono: true }
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return { color: '#4c9a5e', label: 'IMG', textSize: 9 }
    default:
      return { color: '#7a8698', label: 'FILE', textSize: 7 }
  }
}

export default function FileIcon({ name, mime, size = 44 }: FileIconProps) {
  const k = kindFor(name, mime)
  const corner = Math.max(4, size * 0.14)
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className="file-icon"
      role="img"
      aria-label={name}
    >
      {/* 彩色圆角方块 */}
      <rect x="1" y="1" width="46" height="46" rx={corner} fill={k.color} />
      {/* 折角（右上） */}
      <path d="M30 1 H47 V18 L30 1 Z" fill="#ffffff" opacity="0.28" />
      <path d="M30 1 H40 L47 8 V18 L30 1 Z" fill="#ffffff" opacity="0.5" />
      {/* 居中缩写 */}
      <text
        x="23"
        y="27"
        textAnchor="middle"
        dominantBaseline="middle"
        fontSize={k.textSize}
        fontWeight="700"
        fill="#ffffff"
        fontFamily={
          k.mono
            ? "'JetBrains Mono', Consolas, monospace"
            : "-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif"
        }
      >
        {k.label}
      </text>
    </svg>
  )
}
