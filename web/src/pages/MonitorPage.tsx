// 监控中心（仅 admin）：Agent 指标 + 系统/宿主指标 + 服务健康 + 对话审计
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ClipboardCopy, Download, Eye, LogOut, PackageOpen } from 'lucide-react'
import {
  exportAllAudit,
  exportAuditConversation,
  fetchAuditTranscript,
  fetchMonitorOverview,
  listAuditConversations,
  logout,
  type AuditConv,
  type AuditMsg,
  type MonitorOverview,
} from '../api/client'
import { Button } from '../components/ui/button'

const HOUR_LABELS = ['0点', '2点', '4点', '6点', '8点', '10点', '12点', '14点', '16点', '18点', '20点', '22点']

function fmtNum(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}
function fmtBytes(b?: number): string {
  if (b == null) return '—'
  if (b >= 1 << 30) return `${(b / (1 << 30)).toFixed(1)} GB`
  if (b >= 1 << 20) return `${(b / (1 << 20)).toFixed(1)} MB`
  return `${(b / 1024).toFixed(0)} KB`
}
function hourLabel(h: string): string {
  const d = new Date(h)
  return `${d.getHours()}时`
}

function StatCard({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: string }) {
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}

function HealthDot({ status }: { status: string }) {
  const ok = status === 'ok'
  return (
    <span className={`health-dot ${ok ? 'ok' : 'down'}`} title={status}>
      {ok ? '● 正常' : '● 异常'}
    </span>
  )
}

export default function MonitorPage() {
  const [data, setData] = useState<MonitorOverview | null>(null)
  const [error, setError] = useState('')

  async function load() {
    try {
      const d = await fetchMonitorOverview()
      setData(d)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    }
  }
  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 15000)
    return () => clearInterval(t)
  }, [])

  const a = data?.agent
  const buckets = a?.buckets ?? []
  const maxChats = Math.max(1, ...buckets.map((b) => b.chats))
  const maxTools = Math.max(1, ...buckets.map((b) => b.tool_calls + b.codex_runs))
  const modes = Object.entries(a?.by_mode ?? {})
  const skills = Object.entries(a?.by_skill ?? {})
    .sort((x, y) => y[1] - x[1])
    .slice(0, 8)
  const host = data?.system?.host
  const containers = data?.system?.containers ?? []
  const db = data?.db

  // 对话审计
  const [convs, setConvs] = useState<AuditConv[]>([])
  const [convErr, setConvErr] = useState('')
  const [transcript, setTranscript] = useState<{ conv: AuditConv; msgs: AuditMsg[] } | null>(null)
  const [search, setSearch] = useState('')

  async function loadConvs() {
    try {
      const { conversations } = await listAuditConversations()
      setConvs(conversations)
      setConvErr('')
    } catch (e) {
      setConvErr(e instanceof Error ? e.message : '加载会话失败')
    }
  }
  useEffect(() => {
    void loadConvs()
  }, [])

  async function openTranscript(c: AuditConv) {
    try {
      const t = await fetchAuditTranscript(c.id)
      setTranscript({ conv: t.conversation, msgs: t.messages })
    } catch (e) {
      setConvErr(e instanceof Error ? e.message : '加载问答失败')
    }
  }

  const filteredConvs = convs.filter((c) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return (
      (c.title || '').toLowerCase().includes(q) ||
      (c.username || '').toLowerCase().includes(q) ||
      (c.display_name || '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-bold">监控中心</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Agent 运行情况（近 {data?.window_hours ?? 24} 小时）与服务器状态，每 15 秒自动刷新。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link to="/" className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
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

      <div className="monitor-scroll">
        {error && <div className="error-banner">⚠ {error}</div>}

        {/* 服务健康 */}
        <section className="monitor-section">
          <h2 className="monitor-h2">服务健康</h2>
          <div className="health-strip">
            <span className="health-item">
              应用服务 <HealthDot status="ok" />
            </span>
            <span className="health-item">
              沙箱 worker <HealthDot status={data?.system?.available ? 'ok' : 'down'} />
            </span>
            <span className="health-item">
              数据库 <HealthDot status={db?.available ? 'ok' : 'unknown'} />
            </span>
            <span className="health-item mute">
              运行时长 {(data?.uptime_sec ?? 0) >= 3600 ? `${(data!.uptime_sec / 3600).toFixed(1)} 小时` : `${Math.floor((data?.uptime_sec ?? 0) / 60)} 分钟`}
            </span>
          </div>
        </section>

        {/* Agent 指标 */}
        <section className="monitor-section">
          <h2 className="monitor-h2">对话统计（近 24 小时）</h2>
          <div className="stat-grid">
            <StatCard label="对话轮次" value={fmtNum(a?.chats ?? 0)} sub={`成功 ${a?.chat_ok ?? 0} · 错误 ${a?.chat_err ?? 0} · 反问 ${a?.asks ?? 0}`} />
            <StatCard label="自动调用" value={fmtNum((a?.tools ?? 0) + (a?.codex_runs ?? 0))} sub={`普通工具 ${a?.tools ?? 0} · 代码执行 ${a?.codex_runs ?? 0}`} />
            <StatCard label="模型用量" value={fmtNum((a?.prompt_tokens ?? 0) + (a?.completion_tokens ?? 0))} sub={`输入 ${fmtNum(a?.prompt_tokens ?? 0)} · 输出 ${fmtNum(a?.completion_tokens ?? 0)}`} accent="var(--ccnu-blue)" />
            <StatCard label="平均延迟" value={`${Math.round(a?.avg_latency_ms ?? 0)}ms`} sub={`P50 ${Math.round(a?.p50_ms ?? 0)}ms · P95 ${Math.round(a?.p95_ms ?? 0)}ms`} />
            <StatCard label="代码执行成功率" value={a && a.codex_runs > 0 ? `${Math.round(((a.codex_ok ?? 0) / a.codex_runs) * 100)}%` : '—'} sub={`${a?.codex_ok ?? 0}/${a?.codex_runs ?? 0} 成功`} accent="var(--success)" />
            <StatCard label="错误数" value={fmtNum(a?.chat_err ?? 0)} sub="对话级错误" accent={a && a.chat_err ? 'var(--danger)' : undefined} />
          </div>

          <div className="monitor-cols">
            {/* 24h 柱状图 */}
            <div className="monitor-panel">
              <div className="monitor-panel-title">对话与自动调用（逐小时）</div>
              <div className="bar-chart" aria-hidden>
                {buckets.map((b, i) => (
                  <div key={b.hour} className="bar-col" title={`${hourLabel(b.hour)} 对话${b.chats} 工具${b.tool_calls + b.codex_runs}`}>
                    <div className="bar-track">
                      <div className="bar bar-tool" style={{ height: `${((b.tool_calls + b.codex_runs) / maxTools) * 100}%` }} />
                      <div className="bar bar-chat" style={{ height: `${(b.chats / maxChats) * 100}%` }} />
                    </div>
                    {i % 2 === 0 ? <span className="bar-label">{hourLabel(b.hour)}</span> : <span className="bar-label empty" />}
                  </div>
                ))}
              </div>
              <div className="legend">
                <span><i className="lg lg-chat" /> 对话</span>
                <span><i className="lg lg-tool" /> 工具/沙箱</span>
              </div>
            </div>

            <div className="monitor-panel">
              <div className="monitor-panel-title">按模式分布</div>
              {modes.length === 0 ? (
                <div className="monitor-empty">暂无数据</div>
              ) : (
                <div className="dist-list">
                  {modes.map(([k, v]) => (
                    <div key={k} className="dist-row">
                      <span className="dist-name">{modeLabel(k)}</span>
                      <span className="dist-bar-wrap">
                        <span className="dist-bar" style={{ width: `${(v / Math.max(1, modes[0][1])) * 100}%` }} />
                      </span>
                      <span className="dist-val">{v}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="monitor-panel-title" style={{ marginTop: 16 }}>学习功能 / 自动调用</div>
              {skills.length === 0 ? (
                <div className="monitor-empty">暂无数据</div>
              ) : (
                <div className="dist-list">
                  {skills.map(([k, v]) => (
                    <div key={k} className="dist-row">
                      <span className="dist-name">{k}</span>
                      <span className="dist-bar-wrap">
                        <span className="dist-bar gold" style={{ width: `${(v / Math.max(1, skills[0][1])) * 100}%` }} />
                      </span>
                      <span className="dist-val">{v}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 业务审计：全站用户问答 */}
        <section className="monitor-section">
          <h2 className="monitor-h2">用户对话记录（提问 / 回答）</h2>
          {convErr && <div className="error-banner">⚠ {convErr}</div>}
          <div className="audit-search">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索用户 / 会话标题…"
            />
            <span className="audit-count">共 {filteredConvs.length} 个会话</span>
            {convs.length > 0 && (
              <button
                className="btn-primary sm export-all-btn"
                onClick={() => void exportAllAudit().catch((e) => setConvErr(e instanceof Error ? e.message : '导出失败'))}
              >
                <PackageOpen className="size-3.5" /> 一键导出全部会话（zip）
              </button>
            )}
            {convs.length > 0 && (
              <button
                className="btn-ghost"
                onClick={() => {
                  const lines = convs.map((c) => `${c.username}\t${c.title}\t${c.mode}`)
                  navigator.clipboard.writeText(lines.join('\n'))
                }}
              >
                <ClipboardCopy className="size-3.5" /> 复制会话清单
              </button>
            )}
          </div>
          {filteredConvs.length === 0 ? (
            <div className="monitor-empty">暂无会话</div>
          ) : (
            <div className="audit-table">
              <div className="audit-row audit-head">
                <span className="audit-user">用户</span>
                <span className="audit-title-col">会话标题</span>
                <span className="audit-mode">模式</span>
                <span className="audit-time">最后更新</span>
                <span className="audit-op" />
              </div>
              {filteredConvs.map((c) => (
                <div key={c.id} className="audit-row">
                  <span className="audit-user">
                    <span className="audit-avatar">{(c.display_name || c.username || '?').slice(0, 1).toUpperCase()}</span>
                    <span>
                      <span className="audit-uname">{c.display_name || c.username}</span>
                      <span className="audit-login">@{c.username}</span>
                    </span>
                  </span>
                  <span className="audit-title-col" title={c.title}>
                    {c.title || '（无标题）'}
                  </span>
                  <span className="audit-mode">{modeLabel(c.mode)}</span>
                  <span className="audit-time">{new Date(c.updated_at).toLocaleString()}</span>
                  <span className="audit-op">
                    <button className="hist-artifact-dl" onClick={() => void openTranscript(c)}>
                      <Eye className="size-3.5" /> 问答
                    </button>
                    <button className="btn-ghost-sm" onClick={() => void exportAuditConversation(c)}>
                      <Download className="size-3.5" /> 导出
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 系统 / 宿主 / 容器 */}
        <section className="monitor-section">
          <h2 className="monitor-h2">系统资源</h2>
          {!data?.system?.available ? (
            <div className="monitor-empty">系统指标不可用（codex worker 未启用或未挂载宿主）。{data?.system?.error ? `原因：${data.system.error}` : ''}</div>
          ) : (
            <div className="monitor-cols">
              <div className="monitor-panel">
                <div className="monitor-panel-title">ECS 宿主（{host?.hostname ?? 'unknown'} · {host?.cpu_cores ?? '?'} 核）</div>
                <div className="sys-rows">
                  <SysRow label="内存" value={host ? `${((1 - (host.mem_avail_kb ?? 0) / (host.mem_total_kb || 1)) * 100).toFixed(0)}%` : '—'}
                    detail={host ? `${fmtBytes((host.mem_total_kb - host.mem_avail_kb) * 1024)} / ${fmtBytes(host.mem_total_kb * 1024)}` : ''} />
                  <SysRow label="磁盘" value={host?.disk_use_pct != null ? `${host.disk_use_pct.toFixed(1)}%` : '—'}
                    danger={host?.disk_use_pct != null && host.disk_use_pct > 80}
                    detail={host ? `可用 ${fmtBytes((host.disk_free_kb ?? 0) * 1024)} / 共 ${fmtBytes((host.disk_total_kb ?? 0) * 1024)}` : ''} />
                  <SysRow label="负载 1/5/15 分钟" value={host ? host.load_avg.map((v) => v.toFixed(2)).join(' / ') : '—'} />
                </div>
              </div>
              <div className="monitor-panel">
                <div className="monitor-panel-title">容器（CPU% · 内存）</div>
                {containers.length === 0 ? (
                  <div className="monitor-empty">容器数据为空</div>
                ) : (
                  <div className="container-list">
                    {containers.map((c) => (
                      <div key={c.name} className="container-row">
                        <span className="c-name">{shortName(c.name)}</span>
                        <span className="c-val">CPU {c.cpu || '—'}</span>
                        <span className="c-val">{c.mem || '—'}（{c.mem_perc || '—'}）</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </section>

        {/* 数据库 */}
        <section className="monitor-section">
          <h2 className="monitor-h2">PostgreSQL</h2>
          {!db?.available ? (
            <div className="monitor-empty">数据库统计不可用（当前使用内存存储或查询失败）。{db?.error ? `原因：${db.error}` : ''}</div>
          ) : (
            <div className="stat-grid">
              <StatCard label="连接数" value={`${db.connections ?? 0} / ${db.max_conn ?? '?'}`} />
              <StatCard label="库大小" value={fmtBytes(db.db_bytes ?? 0)} sub={db.db_name ?? ''} />
              <StatCard label="缓存命中率" value={db.cache_hit != null ? `${(db.cache_hit * 100).toFixed(1)}%` : '—'} />
              <StatCard label="事务 提交/回滚" value={`${fmtNum(db.commit ?? 0)} / ${fmtNum(db.rollback ?? 0)}`} />
            </div>
          )}
        </section>
        <p className="composer-hint" style={{ paddingBottom: 16 }}>
          数据更新于 {data ? new Date(data.generated_at).toLocaleTimeString() : '—'} · {data ? `${data.window_hours}h 窗口` : ''} · {HOUR_LABELS.length ? '自动刷新 15s' : ''}
        </p>
      </div>

      {/* 问答详情弹窗 */}
      {transcript && (
        <div className="modal-mask" onClick={() => setTranscript(null)}>
          <div className="modal audit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="toolbar-title">
                问答：{(transcript.conv.display_name || transcript.conv.username)} · {transcript.conv.title || '无标题'}
              </span>
              <span className="audit-actions">
                <button className="btn-ghost-sm" onClick={() => void exportAuditConversation(transcript.conv)}>
                  <Download className="size-3.5" /> 导出 txt
                </button>
                <button onClick={() => setTranscript(null)}>✕</button>
              </span>
            </div>
            <div className="modal-body transcript-body">
              {transcript.msgs.length === 0 ? (
                <div className="monitor-empty">该会话暂无问答记录</div>
              ) : (
                transcript.msgs.map((m) => (
                  <div key={m.id} className={`tr-msg ${m.role}`}>
                    <div className="tr-who">{m.role === 'user' ? '学生' : '助教'}</div>
                    <div className="tr-content">{m.content}</div>
                    <div className="tr-time">{new Date(m.created_at).toLocaleString()}</div>
                  </div>
                ))
              )}
            </div>
            <div className="modal-foot">
              <button className="btn-ghost" onClick={() => setTranscript(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function SysRow({ label, value, detail, danger }: { label: string; value: string; detail?: string; danger?: boolean }) {
  return (
    <div className="sys-row">
      <span className="sys-label">{label}</span>
      <span className="sys-value" style={danger ? { color: 'var(--danger)' } : undefined}>
        {danger && value.includes('%') ? `⚠ ${value}` : value}
      </span>
      {detail && <span className="sys-detail">{detail}</span>}
    </div>
  )
}

function modeLabel(m: string): string {
  switch (m) {
    case 'companion':
      return '智能助教'
    case 'practice':
      return '练习'
    case 'teacher':
      return '教师'
    case 'none':
      return '未指定'
    default:
      return m
  }
}
function shortName(n: string): string {
  return n.replace(/^ccnu_lesson_agent[-_]*/, '')
}
