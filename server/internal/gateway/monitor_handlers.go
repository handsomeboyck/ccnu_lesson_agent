package gateway

import (
	"context"
	"net/http"
	"sort"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// monitorService 提供 admin 监控聚合（/v1/monitor/overview）。
type monitorService struct {
	store    store.Store
	codex    *codex.Client
	started  time.Time
}

// overview 把 Agent 指标、Postgres 状态、宿主/容器指标合并成一个快照。
func (m *monitorService) overview(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	const hours = 24

	sum, err := m.store.MetricSummary(ctx, hours)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "metric summary: "+err.Error())
		return
	}
	dist, err := m.store.MetricDistribution(ctx, hours)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "metric dist: "+err.Error())
		return
	}
	lats, err := m.store.RecentLatencies(ctx, hours, 1000)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "metric lat: "+err.Error())
		return
	}
	p50, p95 := latPercentiles(lats)

	// 汇总 24h 合计
	var tot store.HourBucket
	for _, b := range sum.Buckets {
		tot.Chats += b.Chats
		tot.ChatOK += b.ChatOK
		tot.ChatErr += b.ChatErr
		tot.Asks += b.Asks
		tot.ToolCalls += b.ToolCalls
		tot.CodexRuns += b.CodexRuns
		tot.CodexOK += b.CodexOK
		tot.PromptTok += b.PromptTok
		tot.Completion += b.Completion
		tot.DurationSum += b.DurationSum
	}
	avgLat := 0.0
	if tot.Chats > 0 {
		avgLat = float64(tot.DurationSum) / float64(tot.Chats)
	}

	resp := map[string]any{
		"generated_at": time.Now(),
		"uptime_sec":   int64(time.Since(m.started).Seconds()),
		"window_hours": hours,
		"agent": map[string]any{
			"chats":     tot.Chats,
			"chat_ok":   tot.ChatOK,
			"chat_err":  tot.ChatErr,
			"asks":      tot.Asks,
			"tools":     tot.ToolCalls,
			"codex_runs": tot.CodexRuns,
			"codex_ok":  tot.CodexOK,
			"prompt_tokens":  tot.PromptTok,
			"completion_tokens": tot.Completion,
			"duration_sum_ms": tot.DurationSum,
			"avg_latency_ms":  avgLat,
			"p50_ms":          p50,
			"p95_ms":          p95,
			"by_mode":         dist.ByMode,
			"by_skill":        dist.BySkill,
			"buckets":         sum.Buckets,
		},
		"db":     m.dbStats(ctx),
		"system": m.systemStats(ctx),
	}
	writeJSON(w, http.StatusOK, resp)
}

// dbStats Postgres 状态；非 PG（内存 store）返回 nil 由前端降级显示。
func (m *monitorService) dbStats(ctx context.Context) any {
	prov, ok := m.store.(store.SystemStatsProvider)
	if !ok {
		return map[string]any{"available": false}
	}
	st, err := prov.SystemStats(ctx)
	if err != nil {
		return map[string]any{"available": false, "error": err.Error()}
	}
	return map[string]any{
		"available":     true,
		"pg_version":    st.PGVersion,
		"db_name":       st.DBName,
		"connections":   st.Connections,
		"max_conn":      st.MaxConnections,
		"db_bytes":      st.DBBytes,
		"cache_hit":     st.CacheHitRatio,
		"commit":        st.CommitCount,
		"rollback":      st.RollbackCount,
		"uptime_sec":    st.UptimeSec,
	}
}

// systemStats 宿主与容器（codex worker 侧采集；未启用/不可用时降级）。
func (m *monitorService) systemStats(ctx context.Context) map[string]any {
	out := map[string]any{"available": false}
	if m.codex == nil || !m.codex.Enabled() {
		return out
	}
	sys, err := m.codex.SysMetrics()
	if err != nil {
		out["error"] = err.Error()
		return out
	}
	out["available"] = true
	out["host"] = sys.Host
	out["containers"] = sys.Containers
	return out
}

// serviceHealth 三服务健康状态（app 本身恒健康由存在性体现；db/codex 即时探测）。
func (m *monitorService) serviceHealth(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	resp := map[string]any{
		"app":  map[string]string{"status": "ok"},
		"db":   map[string]string{"status": "unknown"},
		"codex": map[string]string{"status": "unknown"},
	}
	if prov, ok := m.store.(store.SystemStatsProvider); ok {
		if err := prov.PingDB(ctx); err != nil {
			resp["db"] = map[string]string{"status": "down", "error": err.Error()}
		} else {
			resp["db"] = map[string]string{"status": "ok"}
		}
	}
	if m.codex != nil && m.codex.Enabled() {
		if err := m.codex.Health(); err != nil {
			resp["codex"] = map[string]string{"status": "down", "error": err.Error()}
		} else {
			resp["codex"] = map[string]string{"status": "ok"}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// topSkills 截取技能分布 top N（降序 key）。
func topSkills(m map[string]int64, n int) []struct {
	Skill string `json:"skill"`
	Count int64  `json:"count"`
} {
	type kv struct {
		k string
		v int64
	}
	var ks []kv
	for k, v := range m {
		ks = append(ks, kv{k, v})
	}
	sort.Slice(ks, func(i, j int) bool { return ks[i].v > ks[j].v })
	if len(ks) > n {
		ks = ks[:n]
	}
	out := make([]struct {
		Skill string `json:"skill"`
		Count int64  `json:"count"`
	}, 0, len(ks))
	for _, x := range ks {
		out = append(out, struct {
			Skill string `json:"skill"`
			Count int64  `json:"count"`
		}{x.k, x.v})
	}
	return out
}
