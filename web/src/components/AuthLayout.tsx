// 登录/注册共用外壳：左品牌栏（校徽 + 标语）+ 右表单卡。
import type { ReactNode } from 'react'

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-full items-stretch bg-background">
      <aside className="hidden w-1/2 flex-col justify-between bg-ccnu-blue p-12 text-white lg:flex">
        <div>
          <div className="flex size-14 items-center justify-center rounded-full border border-white/25 bg-white/10 font-display text-2xl font-bold">
            华
          </div>
          <div className="mt-6 font-display text-2xl font-bold leading-snug">华中师范大学 · 智能助教</div>
          <div className="mt-2 text-sm text-ccnu-gold">求实创新 · 立德树人</div>
          <p className="mt-6 max-w-md text-sm leading-relaxed text-white/75">
            面向师生的 AI 智能助教：多轮问答 · 生成教案与试卷 · 文档分析与图表产出。以师范精神赋能教与学。
          </p>
        </div>
        <div className="text-xs text-white/60">Central China Normal University / CCNU AI</div>
      </aside>
      <main className="flex flex-1 items-center justify-center bg-background px-4 py-10">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  )
}
