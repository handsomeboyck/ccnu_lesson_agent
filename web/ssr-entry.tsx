// SSR 冒烟入口：渲染 ChatPage 初始状态（欢迎屏）+ 断言关键标记。
import { renderToString } from 'react-dom/server'
import { createElement } from 'react'
import { StaticRouter } from 'react-router'
import ChatPage from './src/pages/ChatPage'

try {
  const html = renderToString(
    createElement(StaticRouter, { location: '/chat' }, createElement(ChatPage)),
  )
  const checks = {
    '渲染产出非空 HTML': html.length > 500,
    '包含品牌标题「华中师范大学」': html.includes('华中师范大学'),
    '包含欢迎引导「诊断教学设计」': html.includes('诊断教学设计'),
    '包含模式标签「智能助教」': html.includes('智能助教'),
    '包含输入框占位': html.includes('输入消息') || html.includes('输入 / 唤起快捷功能'),
  }
  let ok = 0
  for (const [name, pass] of Object.entries(checks)) {
    console.log(`${pass ? '✓' : '✗'} ${name}`)
    if (pass) ok++
  }
  console.log(`\n==== SSR 冒烟: ${ok}/${Object.keys(checks).length} 通过（HTML ${html.length} 字节）====`)
  process.exit(ok === Object.keys(checks).length ? 0 : 1)
} catch (e) {
  console.log('✗ SSR 渲染失败:')
  console.log(e && e.stack ? e.stack.slice(0, 2000) : String(e))
  process.exit(1)
}
