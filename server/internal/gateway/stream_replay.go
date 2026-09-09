package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// streamRegistry 管理所有活跃的流缓冲。
type streamRegistry struct {
	mu           sync.Mutex
	bufs         map[string]*streamBuffer // streamId → buffer
	convToStream map[string]string        // conversationId → streamId（官方 resume 端点用）
}

func newStreamRegistry() *streamRegistry {
	return &streamRegistry{bufs: map[string]*streamBuffer{}, convToStream: map[string]string{}}
}

func (r *streamRegistry) create() (string, *streamBuffer) {
	id := genStreamID()
	buf := newStreamBuffer(8192) // 环形缓冲 8192 条 chunk：完整保留 start/text-start 等协议头
	// （cap 太小会覆盖最早的 text-start → SDK resume 报 missing text part → 刷新断开）
	r.mu.Lock()
	r.bufs[id] = buf
	r.mu.Unlock()
	return id, buf
}

func (r *streamRegistry) get(id string) *streamBuffer {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bufs[id]
}

// bind 记录 conversationId → streamId（官方 resume 端点据此查找活跃流）。
func (r *streamRegistry) bind(convID, streamID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.convToStream[convID] = streamID
}

// unbind 解除 conversationId → streamId 映射（流关闭时）。
func (r *streamRegistry) unbind(convID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.convToStream, convID)
}

// streamByConv 按会话找活跃流；返回 (streamId, buffer, 是否存在)。
func (r *streamRegistry) streamByConv(convID string) (string, *streamBuffer, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	sid, ok := r.convToStream[convID]
	if !ok {
		return "", nil, false
	}
	buf, ok2 := r.bufs[sid]
	return sid, buf, ok && ok2
}

func (r *streamRegistry) remove(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.bufs, id)
	for c, s := range r.convToStream {
		if s == id {
			delete(r.convToStream, c)
		}
	}
}

func genStreamID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// handleStreamReplay 重放 /v1/chat/stream/{streamId}?since=N 的流数据。
func (c *chatService) handleStreamReplay(w http.ResponseWriter, r *http.Request) {
	streamID := r.PathValue("streamId")
	if streamID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "streamId required"})
		return
	}
	since, _ := strconv.ParseInt(r.URL.Query().Get("since"), 10, 64)
	buf := c.streams.get(streamID)
	if buf == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "stream not found or expired"})
		return
	}
	chunks := buf.since(since)

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	flusher, _ := w.(http.Flusher)

	// 重放历史 chunk
	for _, ch := range chunks {
		fmt.Fprintf(w, "data: %s\n\n", ch.Data)
		if flusher != nil {
			flusher.Flush()
		}
	}

	// 生成中 → 继续流式推送新 chunk（轮询 buf.lastSeq）
	if !buf.done {
		last := buf.lastSeq()
		for {
			newLast := buf.lastSeq()
			if newLast > last {
				for _, ch := range buf.since(last + 1) {
					fmt.Fprintf(w, "data: %s\n\n", ch.Data)
					if flusher != nil {
						flusher.Flush()
					}
				}
			}
			if buf.done {
				break
			}
			last = buf.lastSeq()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	// 已完成 → 发 DONE
	fmt.Fprintf(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}

// handleResume 官方 Resume Streams 重连端点：GET /v1/chat/resume/{conversationId}
// 无活跃流 → 204（SDK 视为无可恢复流）；有流 → 以 UI message stream 协议回放缓冲 + 续推新 chunk。
func (c *chatService) handleResume(w http.ResponseWriter, r *http.Request) {
	convID := r.PathValue("conversationId")
	if convID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "conversationId required"})
		return
	}
	_, buf, ok := c.streams.streamByConv(convID)
	if !ok {
		// 官方协议：无活跃流返回 204 No Content
		w.WriteHeader(http.StatusNoContent)
		return
	}

	// 若生成仍在进行：等待其完成（最多 3 分钟），然后一次性回放全部 chunk + [DONE]。
	// 不依赖客户端长连接稳定（SDK 可能因 Chat 重建 abort 首次 resume），
	// 任何时刻重连都能拿到完整流。
	if !buf.done {
		deadline := time.Now().Add(3 * time.Minute)
		for {
			if buf.done {
				break
			}
			if time.Now().After(deadline) {
				break
			}
			select {
			case <-r.Context().Done():
				return // 客户端断开，静默
			case <-time.After(100 * time.Millisecond):
			}
		}
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("x-vercel-ai-ui-message-stream", "v1")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	// 回放全部 chunk（seq ≥ 0 = 全量）
	chunks := buf.since(0)
	for _, ch := range chunks {
		fmt.Fprintf(w, "data: %s\n\n", ch.Data)
		if flusher != nil {
			flusher.Flush()
		}
	}
	fmt.Fprintf(w, "data: [DONE]\n\n")
	if flusher != nil {
		flusher.Flush()
	}
}