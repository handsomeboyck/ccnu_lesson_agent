// Package ingest 负责用户上传文档的解析与分块。
// 支持：PDF、DOCX（含 .doc 转换提示）、XLSX、TXT/MD。
// 产物为文本块（chunks），供资料库检索注入模型上下文。
package ingest

import (
	"archive/zip"
	"bytes"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/ledongthuc/pdf"
	"github.com/xuri/excelize/v2"
)

// ErrUnsupported 不支持的文件类型。
var ErrUnsupported = errors.New("ingest: unsupported file type")

// ExtOf 返回小写扩展名（去点）。
func ExtOf(name string) string {
	return strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
}

// ParseFile 解析本地文件，返回抽取文本与错误。
func ParseFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return ParseBytes(filepath.Base(path), data)
}

// ParseBytes 按文件名后缀解析内容为纯文本。
func ParseBytes(filename string, data []byte) (string, error) {
	switch ExtOf(filename) {
	case "pdf":
		return parsePDF(bytes.NewReader(data))
	case "docx":
		return parseDOCX(data)
	case "doc":
		return "", fmt.Errorf("暂不支持旧版 .doc 二进制格式，请在 Word 中另存为 .docx 后重试（%w 提示）", ErrUnsupported)
	case "xlsx":
		return parseXLSX(data)
	case "txt", "md", "csv", "markdown":
		return string(data), nil
	default:
		return "", fmt.Errorf("不支持的文件类型 .%s（支持 pdf/docx/xlsx/txt/md）: %w", ExtOf(filename), ErrUnsupported)
	}
}

// ChunkSize / ChunkOverlap 分块参数（中文字符安全按 rune 切）。
const (
	ChunkSize    = 800
	ChunkOverlap = 120
)

// ChunkText 把长文本切成检索块。
func ChunkText(text string) []string {
	runes := []rune(strings.TrimSpace(text))
	if len(runes) == 0 {
		return nil
	}
	var out []string
	for start := 0; start < len(runes); start += (ChunkSize - ChunkOverlap) {
		end := start + ChunkSize
		if end > len(runes) {
			end = len(runes)
		}
		part := string(runes[start:end])
		if strings.TrimSpace(part) != "" {
			out = append(out, part)
		}
		if end == len(runes) {
			break
		}
	}
	return out
}

// ---- PDF ----

func parsePDF(r io.ReaderAt) (string, error) {
	reader, err := pdf.NewReader(r, int64(readerLen(r)))
	if err != nil {
		return "", fmt.Errorf("pdf open: %w", err)
	}
	var sb strings.Builder
	for i := 1; i <= reader.NumPage(); i++ {
		page := reader.Page(i)
		text, err := page.GetPlainText(nil)
		if err != nil {
			continue
		}
		sb.WriteString(text)
		sb.WriteString("\n")
	}
	return sb.String(), nil
}

// readerLen 需要 io.ReaderAt 的长度：优先 *bytes.Reader 等。
func readerLen(r io.ReaderAt) int64 {
	if br, ok := r.(*bytes.Reader); ok {
		return br.Size()
	}
	return 1 << 20
}

// ---- DOCX（zip + word/document.xml 文本节点）----

type docxDocument struct {
	Body struct {
		Paragraphs []struct {
			Runs []struct {
				Text string `xml:"t"`
			} `xml:"r"`
		} `xml:"p"`
	} `xml:"body"`
}

func parseDOCX(data []byte) (string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", fmt.Errorf("docx open: %w", err)
	}
	for _, f := range zr.File {
		// 兼容不同打包器的分隔符（\ 或 /）
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if name != "word/document.xml" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return "", err
		}
		defer rc.Close()
		var doc docxDocument
		dec := xml.NewDecoder(rc)
		if err := dec.Decode(&doc); err != nil {
			return "", fmt.Errorf("docx xml: %w", err)
		}
		var sb strings.Builder
		for _, p := range doc.Body.Paragraphs {
			for _, r := range p.Runs {
				sb.WriteString(r.Text)
			}
			sb.WriteString("\n")
		}
		return sb.String(), nil
	}
	return "", errors.New("docx: word/document.xml not found")
}

// ---- XLSX（excelize）----

func parseXLSX(data []byte) (string, error) {
	f, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return "", fmt.Errorf("xlsx open: %w", err)
	}
	defer f.Close()
	var sb strings.Builder
	for _, sheet := range f.GetSheetList() {
		sb.WriteString("【工作表：" + sheet + "】\n")
		rows, err := f.GetRows(sheet)
		if err != nil {
			continue
		}
		for _, row := range rows {
			// 跳过全空行
			nonEmpty := false
			for _, c := range row {
				if strings.TrimSpace(c) != "" {
					nonEmpty = true
					break
				}
			}
			if !nonEmpty {
				continue
			}
			sb.WriteString(strings.Join(trimAll(row), " | "))
			sb.WriteString("\n")
		}
	}
	return sb.String(), nil
}

func trimAll(xs []string) []string {
	out := make([]string, 0, len(xs))
	for _, x := range xs {
		out = append(out, strings.TrimSpace(x))
	}
	return out
}
