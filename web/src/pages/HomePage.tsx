// 首页（未登录展示系统能力，引导注册/登录；已登录自动跳 /chat）
import { Link, Navigate } from 'react-router-dom'
import {
  ArrowRight,
  Code2,
  FileText,
  GraduationCap,
  Library,
  NotebookPen,
  PenLine,
} from 'lucide-react'
import { useAuth } from '../store/auth'
import { buttonVariants } from '../components/ui/button'

const FEATURES = [
  {
    icon: GraduationCap,
    title: '答疑讲解',
    desc: '苏格拉底式引导：讲清概念、辨析易错点、追问教材论断，先启发思考，再给完整答案。',
  },
  {
    icon: NotebookPen,
    title: '练习测评',
    desc: '按知识点与难度出题，批改作答、诊断薄弱点，生成可下载的练习文件。',
  },
  {
    icon: PenLine,
    title: '教案辅助',
    desc: '教学设计质量评估与诊断（师范生专属）：量规打分、证据引用、改进优先级与任务单。',
  },
  {
    icon: Library,
    title: '资料问答',
    desc: '上传讲义、课件与表格，AI 基于你的资料作答并注明出处，而不是凭记忆发挥。',
  },
  {
    icon: FileText,
    title: '文件生成',
    desc: '一句话生成 Word 教案、PPT 课件、PDF 试卷与图表，可直接下载使用。',
  },
  {
    icon: Code2,
    title: '数据处理',
    desc: '内置代码沙箱：成绩统计、数据画图、文件转换，复杂任务交给代码执行。',
  },
]

const STEPS = [
  { step: '1', title: '注册或登录', desc: '使用华师学号 / 教工号即可开始' },
  { step: '2', title: '选择模式', desc: '智能助教 / 练习测评 / 教师辅助' },
  { step: '3', title: '提问或上传', desc: '直接提问，或上传教案与资料让 AI 基于内容作答' },
]

export default function HomePage() {
  const user = useAuth((s) => s.user)
  if (user) return <Navigate to="/chat" replace />

  return (
    <div className="min-h-full bg-background">
      {/* 顶栏 */}
      <header className="sticky top-0 z-40 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-5xl items-center gap-3 px-6">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ccnu-blue font-display text-sm font-bold text-white">
            华
          </div>
          <div className="truncate font-display text-sm font-bold">华中师范大学 · 智能助教</div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Link to="/login" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              登录
            </Link>
            <Link to="/register" className={buttonVariants({ size: 'sm' })}>
              注册使用
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pb-14 pt-16 text-center">
        <div className="mx-auto mb-5 flex size-16 items-center justify-center rounded-full bg-ccnu-blue/10 font-display text-3xl font-bold text-ccnu-blue">
          华
        </div>
        <h1 className="font-display text-3xl font-bold">华中师范大学 · 智能助教</h1>
        <div className="mt-2 text-sm text-ccnu-gold-deep">求实创新 · 立德树人</div>
        <p className="mx-auto mt-4 max-w-2xl text-[15px] leading-relaxed text-muted-foreground">
          面向华师师生的 AI 教学助手：多轮答疑讲解、练习测评、教案评估与诊断、基于个人资料的回答，以及 Word / PPT / PDF / 图表的生成。
        </p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <Link to="/register" className={buttonVariants({ size: 'lg' })}>
            注册使用 <ArrowRight className="size-4" />
          </Link>
          <Link to="/login" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
            已有账号，登录
          </Link>
        </div>
      </section>

      {/* 能力卡片 */}
      <section className="mx-auto max-w-5xl px-6 pb-14">
        <h2 className="mb-6 text-center font-display text-lg font-bold">它能做什么</h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-lg border border-border bg-card p-4">
              <f.icon className="size-5 text-ccnu-blue" />
              <div className="mt-2.5 text-sm font-semibold">{f.title}</div>
              <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 三步上手 */}
      <section className="border-y border-border bg-card/60">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="mb-6 text-center font-display text-lg font-bold">三步开始</h2>
          <div className="grid gap-5 sm:grid-cols-3">
            {STEPS.map((s) => (
              <div key={s.step} className="flex items-start gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ccnu-blue/10 font-display text-sm font-bold text-ccnu-blue">
                  {s.step}
                </span>
                <div>
                  <div className="text-sm font-semibold">{s.title}</div>
                  <p className="mt-0.5 text-[13px] leading-relaxed text-muted-foreground">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 页脚 */}
      <footer className="mx-auto max-w-5xl px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Central China Normal University / CCNU AI</span>
          <div className="flex items-center gap-4">
            <span>AI 生成内容仅供参考，学习请以教材与老师讲解为准</span>
            <a
              href="https://github.com/handsomeboyck/ccnu_lesson_agent"
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              开源仓库
            </a>
          </div>
        </div>
      </footer>
    </div>
  )
}
