// 移动端底部导航（<lg 显示；桌面隐藏）：对话 / 资料库 / 我的文件 / 学习功能（学生隐藏）
import { NavLink } from 'react-router-dom'
import { FolderOpen, Library, MessageSquare, Puzzle } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAuth } from '../store/auth'

const TABS = [
  { to: '/chat', label: '对话', icon: MessageSquare, end: true },
  { to: '/library', label: '资料库', icon: Library },
  { to: '/artifacts', label: '我的文件', icon: FolderOpen },
  { to: '/skills', label: '学习功能', icon: Puzzle, staff: true },
]

export default function MobileTabBar() {
  const role = useAuth((s) => s.user?.role)
  const tabs = TABS.filter((t) => !t.staff || role !== 'student')
  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 flex items-stretch border-t border-border bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
      aria-label="移动端导航"
    >
      {tabs.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.end}
          className={({ isActive }) =>
            cn(
              'flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] transition-colors',
              isActive ? 'font-semibold text-ccnu-blue' : 'text-muted-foreground active:text-ccnu-blue',
            )
          }
        >
          <t.icon className="size-5" />
          {t.label}
        </NavLink>
      ))}
    </nav>
  )
}
