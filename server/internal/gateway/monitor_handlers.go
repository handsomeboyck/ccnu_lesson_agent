package gateway

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// monitorService 提供 admin 监控聚合（/v1/monitor/*）。
type monitorService struct {
	store    store.Store
	codex    *codex.Client
	started  time.Time
	// DeepSeek 余额查询用
	balanceBaseURL string
	balanceAPIKey  string
}

// newMonitorService 构造监控服务（注入 DeepSeek 余额查询凭据）。
func newMonitorService(st store.Store, codexCli *codex.Client, balanceBaseURL, balanceAPIKey string) *monitorService {
	return &monitorService{
		store:          st,
		codex:          codexCli,
		started:        time.Now(),
		balanceBaseURL: balanceBaseURL,
		balanceAPIKey:  balanceAPIKey,
	}
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
		tot.CacheHit += b.CacheHit
		tot.CacheMiss += b.CacheMiss
		tot.DurationSum += b.DurationSum
	}
	avgLat := 0.0
	if tot.Chats > 0 {
		avgLat = float64(tot.DurationSum) / float64(tot.Chats)
	}
	cacheRate := 0.0
	if cacheTotal := tot.CacheHit + tot.CacheMiss; cacheTotal > 0 {
		cacheRate = float64(tot.CacheHit) / float64(cacheTotal) * 100
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
			"cache_hit_tokens":  tot.CacheHit,
			"cache_miss_tokens": tot.CacheMiss,
			"cache_hit_rate":    cacheRate,
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
	// 成本统计（注入 overview 响应，前端一次拿到）
	if cost, err := m.store.TotalCost(ctx, hours); err == nil {
		resp["cost"] = cost
	}
	if users, err := m.store.UserCosts(ctx, hours, 20); err == nil && len(users) > 0 {
		resp["user_costs"] = users
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

// balance 查询 DeepSeek 账户余额。
func (m *monitorService) balance(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	info, err := model.QueryBalance(ctx, m.balanceBaseURL, m.balanceAPIKey)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"balance": info})
}

// userCosts 用户成本排行（专用端点，支持 page 参数）。
func (m *monitorService) userCosts(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()
	items, err := m.store.UserCosts(ctx, 24, 50)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "user costs: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items})
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

// auditConversations 全站会话（admin 审计：显示所有者与时间）。
func (m *monitorService) auditConversations(w http.ResponseWriter, r *http.Request) {
	limit := 500
	if q := r.URL.Query().Get("limit"); q != "" {
		var n int
		if _, err := fmt.Sscanf(q, "%d", &n); err == nil && n > 0 {
			limit = n
		}
	}
	convs, err := m.store.ListAllConversations(r.Context(), limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list: "+err.Error())
		return
	}
	out := make([]map[string]any, 0, len(convs))
	for _, c := range convs {
		out = append(out, map[string]any{
			"id":           c.ID,
			"user_id":      c.UserID,
			"username":     c.Username,
			"display_name": c.DisplayName,
			"title":        c.Title,
			"mode":         c.Mode,
			"created_at":   c.CreatedAt,
			"updated_at":   c.UpdatedAt,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": out, "total": len(out)})
}

// auditTranscript 某个会话的完整问答（admin：不做归属校验）。
func (m *monitorService) auditTranscript(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	conv, err := m.store.GetConversationAdmin(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}
	msgs, err := m.store.ListMessages(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "messages: "+err.Error())
		return
	}
	// 仅展示问答（user/assistant 成对），供审计阅读
	items := make([]msgView, 0, len(msgs))
	for _, msg := range msgs {
		if msg.Role != "user" && msg.Role != "assistant" {
			continue
		}
		items = append(items, toMsgView(msg))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"conversation": map[string]any{
			"id": conv.ID, "username": conv.Username, "display_name": conv.DisplayName,
			"title": conv.Title, "mode": conv.Mode, "created_at": conv.CreatedAt, "updated_at": conv.UpdatedAt,
		},
		"messages": items,
	})
}

// auditExport 简易导出：把某会话问答整理为可读文本（TSV/文本行）。
func (m *monitorService) auditExport(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	conv, err := m.store.GetConversationAdmin(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusNotFound, "conversation not found")
		return
	}
	msgs, err := m.store.ListMessages(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "messages: "+err.Error())
		return
	}
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("会话：%s（用户 %s）\n模式：%s\n创建：%s\n\n",
		conv.Title, conv.Username, conv.Mode, conv.CreatedAt.Format("2006-01-02 15:04:05")))
	for _, msg := range msgs {
		if msg.Role != "user" && msg.Role != "assistant" {
			continue
		}
		who := "学生"
		if msg.Role == "assistant" {
			who = "AI"
		}
		sb.WriteString(fmt.Sprintf("【%s %s】\n%s\n\n", who, msg.CreatedAt.Format("15:04"), msg.Content))
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename*=UTF-8''%s.txt`, url.PathEscape(conv.Title)))
	_, _ = w.Write([]byte(sb.String()))
}

// auditExportAll 一键导出全站会话：zip（users/<用户名>/<会话标题>.txt）+ 总清单 CSV。
func (m *monitorService) auditExportAll(w http.ResponseWriter, r *http.Request) {
	convs, err := m.store.ListAllConversations(r.Context(), 2000)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "list: "+err.Error())
		return
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	// 总清单 CSV
	csvBuf := &bytes.Buffer{}
	cw := csv.NewWriter(csvBuf)
	_ = cw.Write([]string{"username", "display_name", "title", "mode", "created_at", "updated_at", "file"})
	written := 0
	for _, c := range convs {
		msgs, err := m.store.ListMessages(r.Context(), c.ID)
		if err != nil {
			continue
		}
		var qa []*store.Message
		for _, m := range msgs {
			if m.Role == "user" || m.Role == "assistant" {
				qa = append(qa, m)
			}
		}
		if len(qa) == 0 {
			continue // 无问答内容的会话不入清单
		}
		dir := safeFilename(c.Username)
		if dir == "" {
			dir = safeFilename(c.DisplayName)
		}
		if dir == "" {
			dir = "unknown"
		}
		name := safeFilename(c.Title)
		if name == "" {
			name = "chat-" + c.ID
		}
		if len(name) > 60 {
			name = name[:60]
		}
		path := dir + "/" + name + ".txt"

		// 写入会话 txt
		var sb strings.Builder
		sb.WriteString(fmt.Sprintf("标题：%s\n用户：%s（%s）\n模式：%s\n创建：%s\n\n",
			c.Title, c.Username, c.DisplayName, c.Mode, c.CreatedAt.Format("2006-01-02 15:04:05")))
		for _, msg := range qa {
			who := "学生"
			if msg.Role == "assistant" {
				who = "AI 助教"
			}
			sb.WriteString(fmt.Sprintf("【%s %s】\n%s\n\n", who, msg.CreatedAt.Format("15:04"), msg.Content))
		}
		fw, err := zw.Create(path)
		if err == nil {
			_, _ = fw.Write([]byte(sb.String()))
		}
		_ = cw.Write([]string{c.Username, c.DisplayName, c.Title, c.Mode,
			c.CreatedAt.Format(time.RFC3339), c.UpdatedAt.Format(time.RFC3339), path})
		written++
	}
	cw.Flush()
	if fw, err := zw.Create("manifest.csv"); err == nil {
		_, _ = fw.Write(csvBuf.Bytes())
	}
	_ = zw.Close()

	if written == 0 {
		writeError(w, http.StatusNotFound, "没有可导出的会话")
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename*=UTF-8''%s.zip`, url.PathEscape("ccnu_全部会话_"+time.Now().Format("20060102"))))
	_, _ = w.Write(buf.Bytes())
}

// safeFilename 清理文件名（防路径穿越/非法字符）。
func safeFilename(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\r', '\t':
			b.WriteRune('_')
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
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
