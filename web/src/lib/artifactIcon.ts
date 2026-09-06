// 产物文件类型 → 展示图标（按扩展名/mime 映射）。
export function artifactIcon(name: string, mime: string): string {
  const ext = (name.split('.').pop() || '').toLowerCase()
  if (mime.startsWith('image/')) return '🖼️'
  switch (ext) {
    case 'docx':
      return '📝' // Word
    case 'doc':
      return '📝'
    case 'pptx':
      return '📽️' // PowerPoint
    case 'ppt':
      return '📽️'
    case 'xlsx':
      return '📊' // Excel
    case 'xls':
      return '📊'
    case 'pdf':
      return '📕'
    case 'csv':
      return '📋'
    case 'txt':
      return '📄'
    case 'md':
      return '📄'
    case 'json':
      return '🧾'
    case 'html':
      return '🌐'
    default:
      return '📎'
  }
}
