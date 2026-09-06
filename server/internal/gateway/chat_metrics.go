package gateway

import (
	"context"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/model"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/skill"
	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/store"
)

// recordChatMetrics 把一次对话（及期间的工具调用）写入指标表。
// chat 状态：有 error → error；停在 ask → ask；否则 ok。
func recordChatMetrics(ctx context.Context, st store.Store, mode, errorMsg string,
	pendingAsk *skill.Ask, usage *model.Usage, toolCalls map[string]int, d time.Duration) {

	status := "ok"
	if errorMsg != "" {
		status = "error"
	} else if pendingAsk != nil {
		status = "ask"
	}
	ev := &store.MetricEvent{
		Kind:       "chat",
		Mode:       mode,
		Status:     status,
		DurationMs: d.Milliseconds(),
		At:         time.Now(),
	}
	if usage != nil {
		ev.PromptTokens = int64(usage.PromptTokens)
		ev.CompletionTokens = int64(usage.CompletionTokens)
	}
	_ = st.AppendMetric(ctx, ev)

	// 每次工具调用一条 tool 事件（含 execute_code → codex 也在 worker 侧计数）
	now := time.Now()
	for name, n := range toolCalls {
		for i := 0; i < n; i++ {
			_ = st.AppendMetric(ctx, &store.MetricEvent{
				Kind: "tool", Mode: mode, Status: "ok", Skill: name, At: now,
			})
		}
	}
}

// percentiles 计算升序切片的 p50/p95（切片可为空）。
func latPercentiles(ms []int64) (p50, p95 float64) {
	if len(ms) == 0 {
		return 0, 0
	}
	quickSort(ms)
	idx := func(p float64) int {
		i := int(float64(len(ms))*p) - 1
		if i < 0 {
			i = 0
		}
		return i
	}
	return float64(ms[idx(0.50)]), float64(ms[idx(0.95)])
}

func quickSort(a []int64) {
	if len(a) < 2 {
		return
	}
	pivot := a[len(a)/2]
	var l, r []int64
	for _, v := range a {
		if v < pivot {
			l = append(l, v)
		} else if v > pivot {
			r = append(r, v)
		}
	}
	mid := make([]int64, 0, len(a)-len(l)-len(r))
	for _, v := range a {
		if v == pivot {
			mid = append(mid, v)
		}
	}
	quickSort(l)
	quickSort(r)
	copy(a, append(append(l, mid...), r...))
}
