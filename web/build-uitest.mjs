// 沙箱受限环境的 UI 构建脚本（仅本机测试用）：
// 1. patch vite 的 Windows 网络盘探测（exec "net use" 在沙箱下同步抛 EPERM，探测结果可安全忽略）
// 2. CSS 预处理：@import 'tailwindcss' → 旧 dist 编译产物（vendor-tailwind.css）；@theme{} → :root{}
// 3. 用无 tailwind 插件的 config + vite JS API 构建（rolldown in-process，全程不 spawn 子进程）
// 用法：node build-uitest.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VITE_CHUNK = path.join(__dirname, 'node_modules', 'vite', 'dist', 'node', 'chunks', 'node.js')
const SRC_CSS = path.join(__dirname, 'src', 'index.css')
const SRC_CSS_BAK = path.join(__dirname, 'src', 'index.css.bak')

// ---- 1. patch vite（幂等）----
let viteSrc = fs.readFileSync(VITE_CHUNK, 'utf8')
const marker = '/* uitest-patched */'
if (!viteSrc.includes(marker)) {
  // 用正则替换整个 optimizeSafeRealPathSync 函数：去掉 exec("net use") 网络盘探测
  // （沙箱下 spawn 管道同步抛 EPERM；探测结果仅影响网络盘 realpath 映射，本地测试可忽略）
  const re = /function optimizeSafeRealPathSync\(\) \{\n[\s\S]*?\n\}\n/
  const match = viteSrc.match(re)
  if (!match) throw new Error('vite patch target not found')
  const patchedFn = `function optimizeSafeRealPathSync() { safeRealpathSync = fs.realpathSync; } ${marker}\n`
  viteSrc = viteSrc.replace(match[0], patchedFn)
  fs.writeFileSync(VITE_CHUNK, viteSrc, 'utf8')
  console.log('[patch] vite network-drive probe removed')
} else {
  console.log('[patch] vite already patched (skip)')
}

// ---- 2. CSS 预处理 ----
// 用 tailwind v4 官方 API 在 Node 内直接编译完整 CSS：
//   oxide.Scanner 扫描源码提取候选类 → tailwindcss.compile() + build(candidates)
//   （绕开 rolldown 加载 oxide 原生模块失败的问题；vite 只负责把编译产物原样打包）
let css = fs.readFileSync(SRC_CSS, 'utf8')
let changed = false

const { createRequire } = await import('node:module')
const req = createRequire(import.meta.url)
const ox = req('@tailwindcss/oxide')
const tw = await import('tailwindcss')

const scanner = new ox.Scanner({
  sources: [
    { base: __dirname, pattern: 'src/**/*', negated: false },
    { base: __dirname, pattern: 'index.html', negated: false },
  ],
})
const candidates = scanner.scan()
const compiler = await tw.compile(css, {
  base: __dirname,
  loadStylesheet: async (id, base) => {
    if (id === 'tailwindcss') {
      const p = 'node_modules/tailwindcss/index.css'
      return { path: p, base: 'node_modules/tailwindcss', content: fs.readFileSync(path.join(__dirname, p), 'utf8') }
    }
    return null
  },
})
const compiledCss = await compiler.build(candidates)
if (compiledCss && compiledCss.length > 10000) {
  css = compiledCss // 编译产物 = 完整 CSS（含工具类/主题/手写部分）
  changed = true
  console.log(`[css] tailwind compiled OK (${compiledCss.length} bytes, ${candidates.length} candidates)`)
} else {
  console.log('[css] tailwind compile output suspicious, keep original css')
}
// 2b. @theme { ... } → :root { ... }（内容仅为 CSS 变量定义）
if (css.includes('@theme')) {
  css = css.replace('@theme {', ':root {')
  changed = true
}
if (changed) {
  fs.copyFileSync(SRC_CSS, SRC_CSS_BAK)
  fs.writeFileSync(SRC_CSS, css, 'utf8')
  console.log('[css] index.css preprocessed (backup at index.css.bak)')
}

// ---- 3. 构建（vite JS API，in-process）----
try {
  const { build } = await import('vite')
  await build({
    configFile: path.join(__dirname, 'vite.config.uitest.ts'),
    logLevel: 'info',
  })
  console.log('[build] vite build OK')
} finally {
  // ---- 4. 还原源码 CSS ----
  if (fs.existsSync(SRC_CSS_BAK)) {
    fs.copyFileSync(SRC_CSS_BAK, SRC_CSS)
    fs.unlinkSync(SRC_CSS_BAK)
    console.log('[css] index.css restored')
  }
}
