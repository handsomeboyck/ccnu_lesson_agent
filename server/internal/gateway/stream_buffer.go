package gateway

import (
	"encoding/json"
	"sync"
)

// streamChunk 带序号的流片段。
type streamChunk struct {
	Seq  int64           `json:"seq"`
	Data json.RawMessage `json:"data"`
}

// streamBuffer 环形缓冲：固定容量，生成中持续写入，完成后保留一段时间供重放。
type streamBuffer struct {
	mu    sync.Mutex
	ring  []streamChunk // 预分配 cap 的切片，append 后 idx = len(ring) % cap
	done  bool          // 生成已完成（关闭后不再写）
	cap   int
}

func newStreamBuffer(cap int) *streamBuffer {
	return &streamBuffer{cap: cap, ring: make([]streamChunk, 0, cap)}
}

func (s *streamBuffer) append(raw json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return
	}
	ch := streamChunk{Seq: int64(len(s.ring)), Data: raw}
	if len(s.ring) < s.cap {
		s.ring = append(s.ring, ch)
	} else {
		// 环形覆盖：丢掉最旧的一条
		copy(s.ring, s.ring[1:])
		s.ring[s.cap-1] = ch
	}
}

func (s *streamBuffer) close() {
	s.mu.Lock()
	s.done = true
	s.mu.Unlock()
}

// since 返回 seq >= since 的所有 chunk（用于客户端重连重放）。
func (s *streamBuffer) since(sinceSeq int64) []streamChunk {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []streamChunk
	for _, ch := range s.ring {
		if ch.Seq >= sinceSeq {
			out = append(out, ch)
		}
	}
	return out
}

// lastSeq 返回最后一条 chunk 的 seq（-1 表示空）。
func (s *streamBuffer) lastSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.ring) == 0 {
		return -1
	}
	return s.ring[len(s.ring)-1].Seq
}