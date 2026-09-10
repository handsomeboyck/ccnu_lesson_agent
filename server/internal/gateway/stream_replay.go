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
	mu   sync.Mutex
	bufs map[string]*streamBuffer // streamId → buffer
}

func newStreamRegistry() *streamRegistry {
	return &streamRegistry{bufs: map[string]*streamBuffer{}}
}

func (r *streamRegistry) create() (string, *streamBuffer) {
	id := genStreamID()
	buf := newStreamBuffer(512) // 环形缓冲 512 条 chunk（~1-2MB）
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

func (r *streamRegistry) remove(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.bufs, id)
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