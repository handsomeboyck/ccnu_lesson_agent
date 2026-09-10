package gateway

import (
	"bytes"
	"encoding/json"
	"strconv"
	"sync"
	"time"
)

// streamChunk 带序号的流片段（seq 全局单调递增，供断点续传定位）。
type streamChunk struct {
	Seq  int64           `json:"seq"`
	Data json.RawMessage `json:"data"`
}

const (
	// defaultBufferMax 生成期间缓冲上限（条数）：防御性上限，正常不会触发。
	// 真续流要求生成期间不覆盖（刷新后从断点续流必须能重放完整历史），
	// 因此仅在极端超限时丢弃最旧并推进 minSeq（前端据此检测 gap 后降级兜底）。
	defaultBufferMax = 20000
	// bufferTailKeep 流结束后裁剪保留的尾部条数（供重放窗口）。
	bufferTailKeep = 4096
)

// streamBuffer 流缓冲：生成期间线性增长（不覆盖，保证断点续传可重放完整历史），
// 完成后裁剪保留尾部一段时间供重放。
type streamBuffer struct {
	mu       sync.Mutex
	chunks   []streamChunk
	nextSeq  int64     // 下一条 chunk 的 seq（全局单调）
	done     bool      // 生成已完成（关闭后不再写）
	closedAt time.Time // done 时刻（宽限窗口起点）
	max      int       // 生成期间最大条数
}

func newStreamBuffer(max int) *streamBuffer {
	if max <= 0 {
		max = defaultBufferMax
	}
	return &streamBuffer{max: max, chunks: make([]streamChunk, 0, 1024)}
}

// append 写入一条 chunk，返回带 seq 的帧（缓冲与网络共用同一 JSON：
// 主链路输出即缓冲内容，重放端点原样输出；前端按 seq 去重定位断点）。
// seq 以字节级注入 JSON 对象尾部（不依赖反序列化回环，绝不失败、不改动原帧内容）。
// 非 JSON 对象（如 [DONE] 终止符）不注入 seq，原样返回。
func (s *streamBuffer) append(raw json.RawMessage) json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.done {
		return raw
	}
	seq := s.nextSeq
	framed := raw
	trimmed := bytes.TrimRight(raw, " \t\r\n")
	if len(trimmed) > 1 && trimmed[0] == '{' && trimmed[len(trimmed)-1] == '}' {
		framed = append(
			append(append([]byte{}, trimmed[:len(trimmed)-1]...),
				[]byte(`,"seq":`+strconv.FormatInt(seq, 10))...),
			'}',
		)
	}
	ch := streamChunk{Seq: seq, Data: framed}
	s.nextSeq++
	if len(s.chunks) < s.max {
		s.chunks = append(s.chunks, ch)
	} else {
		// 防御性上限：丢弃最旧（minSeq 前进，前端续流将检测到 gap 并降级）
		s.chunks = append(s.chunks[1:], ch)
	}
	return framed
}

// close 标记生成结束并裁剪保留尾部（done 后不再写入，裁剪安全）。
func (s *streamBuffer) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.done = true
	s.closedAt = time.Now()
	if len(s.chunks) > bufferTailKeep {
		tail := make([]streamChunk, bufferTailKeep)
		copy(tail, s.chunks[len(s.chunks)-bufferTailKeep:])
		s.chunks = tail
	}
}

func (s *streamBuffer) isDone() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.done
}

// minSeq 缓冲中最旧 chunk 的 seq（空 = nextSeq，即"空窗口"）。
// 前端断点续传时若请求的 since < minSeq，说明头部已被裁剪/覆盖（gap）。
func (s *streamBuffer) minSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.chunks) == 0 {
		return s.nextSeq
	}
	return s.chunks[0].Seq
}

// since 返回 seq >= since 的所有 chunk（用于断点续传重放）。
func (s *streamBuffer) since(sinceSeq int64) []streamChunk {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]streamChunk, 0, 16)
	for _, ch := range s.chunks {
		if ch.Seq >= sinceSeq {
			out = append(out, ch)
		}
	}
	return out
}

// lastSeq 返回最后一条 chunk 的 seq（空 = -1）。
func (s *streamBuffer) lastSeq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.chunks) == 0 {
		return s.nextSeq - 1
	}
	return s.chunks[len(s.chunks)-1].Seq
}
