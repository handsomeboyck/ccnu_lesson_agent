import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  deleteSkill,
  getSkillDetail,
  listSkills,
  saveSkill,
  type SkillInfo,
} from '../api/client'
import { useAuth } from '../store/auth'

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
    <div className="page-shell">
      <header className="page-header">
        <div>
          <h1>🧩 技能管理</h1>
          <p className="page-sub">
            Skill = SKILL.md 文档（Claude 风格）。新增/修改即生效，无需重启。
            {canManage ? ' 你是教师/管理员，可增删改。' : ' 仅教师/管理员可增删改（当前可查看）。'}
          </p>
        </div>
        <div className="page-actions">
          {canManage && (
            <button className="btn-primary sm" onClick={newSkill}>
              ＋ 新建技能
            </button>
          )}
          <Link to="/" className="btn-ghost">
            ← 回对话
          </Link>
        </div>
      </header>

      {error && (
        <div className="error-banner">
          <span>⚠ {error}</span>
          <button onClick={() => setError('')}>✕</button>
        </div>
      )}
      {info && (
        <div className="info-banner">
          <span>✓ {info}</span>
          <button onClick={() => setInfo('')}>✕</button>
        </div>
      )}

      <div className="split-layout">
        <aside className="skill-side">
          {skills.map((s) => (
            <div key={s.name} className={`skill-row ${selected === s.name ? 'active' : ''}`} onClick={() => void openSkill(s.name)}>
              <div className="skill-row-title">
                {s.name}
                {s.doc ? <span className="tag doc">文档</span> : <span className="tag prim">原语</span>}
              </div>
              <div className="skill-row-desc">{s.description}</div>
              <div className="skill-row-actions">
                {canManage && !s.primitive && (
                  <button
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation()
                      void remove(s.name)
                    }}
                  >
                    🗑
                  </button>
                )}
              </div>
            </div>
          ))}
          {skills.length === 0 && <div className="conv-empty">加载中…</div>}
        </aside>

        <main className="skill-editor">
          {selected ? (
            <>
              <div className="editor-toolbar">
                <span className="toolbar-title">{selected === '__new__' ? '新建技能' : `编辑 ${selected}`}</span>
                {canManage && (
                  <button className="btn-primary sm" onClick={() => void save()} disabled={busy}>
                    {busy ? '保存中…' : '保存并生效'}
                  </button>
                )}
              </div>
              <textarea
                className="md-editor"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                readOnly={!canManage}
                spellCheck={false}
              />
              <p className="composer-hint">SKILL.md 格式：YAML frontmatter（name/description/commands）+ Markdown 执行指引。</p>
            </>
          ) : (
            <div className="editor-empty">← 选择左侧技能查看/编辑，或点「新建技能」。</div>
          )}
        </main>
      </div>
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
