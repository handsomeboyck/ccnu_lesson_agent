package gateway

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
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
	buf := newStreamBuffer(0) // 生成期间不覆盖（默认上限；done 后裁剪保留尾部）
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

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// 断点续传辅助头：前端据此检测"头部已被裁剪/覆盖"（gap）并降级兜底。
	// X-Stream-Min-Seq：缓冲中最旧 chunk 的 seq；请求的 since < minSeq 说明存在缺口。
	w.Header().Set("X-Stream-Min-Seq", strconv.FormatInt(buf.minSeq(), 10))
	w.Header().Set("X-Stream-From-Seq", strconv.FormatInt(since, 10))
	flusher, _ := w.(http.Flusher)

	// 重放历史 chunk（帧即缓冲 JSON，自带 seq；断点续流前端据此去重/推进断点）
	chunks := buf.since(since)
	for _, ch := range chunks {
		writeRawFrame(w, flusher, ch.Data)
	}
	// 重放后的断点 = 本轮快照的最大 seq（不能重新读 lastSeq：
	// 输出期间并发 append 的帧若被 lastSeq 越过，将永久丢失）
	last := since - 1
	if n := len(chunks); n > 0 {
		last = chunks[n-1].Seq
	}

	// 生成中 → 继续流式推送新 chunk（轮询 buf.lastSeq）
	if !buf.done {
		for {
			newLast := buf.lastSeq()
			if newLast > last {
				chunks := buf.since(last + 1)
				for _, ch := range chunks {
					writeRawFrame(w, flusher, ch.Data)
				}
				// ★ 断点 = 本轮实际输出快照的最大 seq（输出期间新增的帧下轮补发，不漏不重）
				if n := len(chunks); n > 0 {
					last = chunks[n-1].Seq
				}
			}
			if buf.done {
				break
			}
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

// writeRawFrame 输出一条缓冲帧（JSON 自带 seq；[DONE] 终止符由调用方单独处理）。
func writeRawFrame(w http.ResponseWriter, flusher http.Flusher, data json.RawMessage) {
	fmt.Fprintf(w, "data: %s\n\n", data)
	if flusher != nil {
		flusher.Flush()
	}
}