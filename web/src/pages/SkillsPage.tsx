import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, FileCode2, LogOut, Plus, Save, Trash2 } from 'lucide-react'
import {
  deleteSkill,
  getSkillDetail,
  listSkills,
  logout,
  saveSkill,
  type SkillInfo,
} from '../api/client'
import { useAuth } from '../store/auth'
import { Button } from '../components/ui/button'
import MobileTabBar from '../components/MobileTabBar'

const NEW_SKILL_TEMPLATE = `---
name: my_skill
description: 一句话说明这个技能何时使用、做什么
commands: [mycmd]
---
# 技能名

## 目标
学生请求什么时使用。

## 执行步骤
1. …
2. …

## 输出格式
Markdown，简体中文。

## 边界
- 哪些不该做
`

const MANAGER_ROLES = new Set(['teacher', 'admin'])

export default function SkillsPage() {
  const user = useAuth((s) => s.user)
  const canManage = MANAGER_ROLES.has(user?.role ?? '')

  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const { skills: list } = await listSkills()
      setSkills(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  async function openSkill(name: string) {
    setError('')
    setInfo('')
    try {
      const d = await getSkillDetail(name)
      setSelected(name)
      setContent(d.content)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取失败')
    }
  }

  function newSkill() {
    setSelected('__new__')
    setContent(NEW_SKILL_TEMPLATE)
    setError('')
    setInfo('')
  }

  async function save() {
    if (!canManage) return
    setBusy(true)
    setError('')
    setInfo('')
    const name = selected === '__new__' ? extractName(content) : selected
    if (!name) {
      setError('无法从 frontmatter 解析 name，请检查第一段 --- 内容')
      setBusy(false)
      return
    }
    try {
      await saveSkill(name, content)
      setSelected(name)
      setInfo(`技能「${name}」已保存并生效`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  async function remove(name: string) {
    if (!canManage) return
    if (!window.confirm(`确定删除技能「${name}」？`)) return
    try {
      await deleteSkill(name)
      if (selected === name) {
        setSelected(null)
        setContent('')
      }
      setInfo(`技能「${name}」已删除`)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 pb-24 pt-8 lg:pb-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">学习功能</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            在这里添加和管理 AI 的快捷功能：每个功能一份说明文档，保存后立即生效，无需重启。
            {canManage ? ' 你是教师/管理员，可增删改。' : ' 仅教师/管理员可增删改（当前可查看）。'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canManage && (
            <Button size="sm" onClick={newSkill}>
              <Plus className="size-3.5" /> 新建技能
            </Button>
          )}
          <Link to="/chat" className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <ArrowLeft className="size-3.5" /> 回对话
          </Link>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void logout()
              window.location.href = '/login'
            }}
          >
            <LogOut className="size-3.5" /> 退出
          </Button>
        </div>
      </header>

      {error && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <span>⚠ {error}</span>
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}
      {info && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm text-success">
          <span>✓ {info}</span>
          <button onClick={() => setInfo('')}>✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="max-h-[70vh] overflow-y-auto rounded-xl border border-border bg-card p-1.5 shadow-sm">
          {skills.map((s) => (
            <div
              key={s.name}
              className={`group flex cursor-pointer flex-col gap-1 rounded-lg px-3 py-2.5 ${
                selected === s.name ? 'bg-ccnu-blue/10' : 'hover:bg-accent'
              }`}
              onClick={() => void openSkill(s.name)}
            >
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <FileCode2 className="size-3.5 text-muted-foreground" />
                {s.name}
                {s.doc ? (
                  <span className="rounded-full bg-ccnu-blue/10 px-1.5 py-0.5 text-[10px] text-ccnu-blue">自定义</span>
                ) : (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">内置</span>
                )}
                {canManage && !s.primitive && (
                  <button
                    className="ml-auto rounded p-0.5 text-muted-foreground opacity-0 hover:bg-accent hover:text-destructive group-hover:opacity-100"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(s.name)
                    }}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <div className="text-xs leading-relaxed text-muted-foreground">{s.description}</div>
            </div>
          ))}
          {skills.length === 0 && <div className="px-3 py-6 text-center text-sm text-muted-foreground">加载中…</div>}
        </aside>

        <main className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          {selected ? (
            <>
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <span className="text-sm font-semibold">{selected === '__new__' ? '新建技能' : `编辑 ${selected}`}</span>
                {canManage && (
                  <Button size="sm" onClick={() => void save()} disabled={busy}>
                    <Save className="size-3.5" /> {busy ? '保存中…' : '保存并生效'}
                  </Button>
                )}
              </div>
              <textarea
                className="h-[60vh] w-full resize-none bg-transparent p-4 font-mono text-xs leading-relaxed outline-none"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                readOnly={!canManage}
                spellCheck={false}
              />
              <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground">
                模板说明：顶部填写功能名称与简介（name / description / commands），正文写清楚何时使用、如何执行。
              </p>
            </>
          ) : (
            <div className="flex h-full min-h-64 items-center justify-center text-sm text-muted-foreground">
              ← 选择左侧技能查看/编辑，或点「新建技能」。
            </div>
          )}
        </main>
      </div>
      <MobileTabBar />
    </div>
  )
}

function extractName(md: string): string | null {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!m) return null
  const fm = m[1]
  const name = fm.match(/^name\s*:\s*([^\s]+)\s*$/m)
  return name ? name[1] : null
}
