// SSR 冒烟测试：验证 ChatPage 集成后组件树可完整渲染（渲染层回归）。
// 用法：node build-ssr-smoke.mjs && node --experimental-webstorage --localstorage-file=... run-ssr-smoke.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 用 rolldown（in-process）把 SSR 入口打包（JSX/TSX 转换由 rolldown 内置 oxc 完成）
const { rolldown } = await import('rolldown')
const bundle = await rolldown({
  input: path.join(__dirname, 'ssr-entry.tsx'),
  platform: 'node',
  resolve: {
    conditionNames: ['node', 'import'],
  },
  moduleTypes: {
    '.css': 'empty', // CSS 不参与 SSR
  },
  plugins: [
    {
      name: 'env-shim',
      transform(code) {
        // 替换 vite 注入的 import.meta.env（SSR 无 vite 运行时）
        if (code.includes('import.meta.env')) {
          return code.replaceAll('import.meta.env.VITE_API_BASE', '""')
        }
        return null
      },
    },
  ],
})
const { output } = await bundle.generate({
  format: 'esm',
  sourcemap: false,
})
fs.writeFileSync(path.join(__dirname, 'ssr-bundle.mjs'), output[0].code, 'utf8')
console.log('[ssr] bundle written, size=' + output[0].code.length)
