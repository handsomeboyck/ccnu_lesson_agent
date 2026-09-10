// UI 测试专用构建配置：无 tailwind 插件（绕开 oxide 原生模块加载，
// 样式由预处理后的 vendor-tailwind.css 提供，见 build-uitest.mjs）。
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
})
