// Package ingest 负责用户上传文档的解析与分块。
// 支持：PDF、DOCX、XLSX、老式 DOC/XLS（catdoc/xls2csv）、TXT/MD/CSV。
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
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/extrame/xls"
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
		// 老式 Word 二进制（6.0/95/97-2003）：antiword 提取；RTF 伪装 .doc 走 RTF 兜底
		text, err := execText("antiword", nil, data, ".doc")
		if err != nil && looksLikeRTF(data) {
			return parseRTF(data), nil
		}
		return text, err
	case "xlsx":
		return parseXLSX(data)
	case "xls":
		// 老式 Excel 二进制：纯 Go 解析（extrame/xls，无 OS 依赖）
		return parseXLS(data)
	case "txt", "md", "csv", "markdown":
		return string(data), nil
	default:
		return "", fmt.Errorf("不支持的文件类型 .%s（支持 pdf/docx/xlsx/txt/md）: %w", ExtOf(filename), ErrUnsupported)
	}
}

// execText 用外部命令行工具从字节数据提取文本（antiword 等；服务端需安装对应包）。
// suffix 用于临时文件后缀（部分工具按扩展名识别格式，如 antiword 要求 .doc）。
func execText(cmd string, args []string, data []byte, suffix string) (string, error) {
	f, err := os.CreateTemp("", "ccnu-ingest-*"+suffix)
	if err != nil {
		return "", err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return "", err
	}
	f.Close()
	out, err := exec.Command(cmd, append(args, name)...).Output()
	if err != nil {
		return "", fmt.Errorf("%s 提取文本失败（服务端需安装 %s）：%w", cmd, cmd, err)
	}
	return string(out), nil
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

// ---- RTF 兜底（部分"老 .doc"实为 RTF）----

var (
	rtfParRe  = regexp.MustCompile(`\\(?:par|line|pard|sect)(?:-?\d+)? ?`)
	rtfHexRe  = regexp.MustCompile(`\\'([0-9a-fA-F]{2})`)
	rtfSkipRe = regexp.MustCompile(`\\[a-zA-Z]+-?\d* ?`)
)

func looksLikeRTF(data []byte) bool {
	t := bytes.TrimLeft(bytes.TrimSpace(data), "\xef\xbb\xbf")
	return bytes.HasPrefix(t, []byte("{\\rtf"))
}

// parseRTF 简化 RTF 文本提取（够用于检索；\uN 中文需真正解析，这里尽力保留可读文本）。
func parseRTF(data []byte) string {
	s := string(data)
	s = rtfParRe.ReplaceAllString(s, "\n")
	s = rtfHexRe.ReplaceAllStringFunc(s, func(m string) string {
		if b, err := strconv.ParseUint(m[2:4], 16, 8); err == nil {
			return string([]byte{byte(b)})
		}
		return ""
	})
	s = rtfSkipRe.ReplaceAllString(s, " ")
	s = strings.ReplaceAll(s, "{", " ")
	s = strings.ReplaceAll(s, "}", " ")
	return strings.TrimSpace(s)
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

// parseXLS 纯 Go 解析老式 Excel（BIFF8/BIFF5，extrame/xls）：逐工作表逐行导出文本。
func parseXLS(data []byte) (string, error) {
	wb, err := xls.OpenReader(bytes.NewReader(data), "utf-8")
	if err != nil {
		return "", fmt.Errorf("xls open: %w", err)
	}
	var sb strings.Builder
	for si := 0; si < wb.NumSheets(); si++ {
		sheet := wb.GetSheet(si)
		if sheet == nil {
			continue
		}
		sb.WriteString(fmt.Sprintf("【工作表 %d】\n", si+1))
		for r := 0; r <= int(sheet.MaxRow); r++ {
			row := sheet.Row(r)
			if row == nil {
				continue
			}
			cells := make([]string, 0, row.LastCol())
			for c := 0; c < row.LastCol(); c++ {
				cells = append(cells, strings.TrimSpace(row.Col(c)))
			}
			sb.WriteString(strings.Join(cells, " | "))
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
