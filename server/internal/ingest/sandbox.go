// 沙箱解析通道：用 codex 沙箱中的成熟解析器（MarkItDown / PyMuPDF）提取文档文本。
// 通过包级注入装配（main.go 设置），避免 ingest 与其它包耦合；沙箱不可用/失败时
// 调用方自动回退本地 Go 解析。支持格式：pdf/docx/pptx/doc/xls/xlsx。
package ingest

import (
	"context"
	"encoding/base64"
	"log"
	"strings"
	"time"

	"github.com/handsomeboyck/ccnu_lesson_agent/server/internal/codex"
)

// SandboxParse 包级注入的沙箱解析器（main.go 装配）：
// 返回 (text, handled, err)——handled=true 表示沙箱成功接管并返回可信文本；
// handled=false 表示沙箱不可用/格式不支持/解析失败，调用方回退本地解析。
var SandboxParse func(filename string, data []byte) (string, bool, error)

// sandboxExtractCode 沙箱内执行的解析脚本：
// 1) MarkItDown 统一转换（pdf/docx/pptx/xls/xlsx → Markdown）；
// 2) PDF 兜底 PyMuPDF（对中文 ToUnicode CMap 处理更强，实测吕艳坤类中文 PDF 提取完整）；
// 3) 结果写 /out/extract.md（经产物通道回传，规避 stdout 64KB 截断）。
const sandboxExtractCode = `
import os, sys, subprocess

src = [f for f in os.listdir('/in') if not f.startswith('.')]
if not src:
    print('NO_INPUT', file=sys.stderr)
    sys.exit(2)
path = '/in/' + src[0]
name = src[0]
ext = name.lower().rsplit('.', 1)[-1] if '.' in name else ''

out = None
# 1) MarkItDown（多格式统一；老式二进制 .doc 不支持会抛错跳过）
try:
    from markitdown import MarkItDown
    r = MarkItDown().convert(path)
    if r and r.text_content and len(r.text_content.strip()) > 20:
        out = r.text_content
except Exception as e:
    print('markitdown skip: %s' % e, file=sys.stderr)

# 2) PDF 兜底：PyMuPDF（中文 CID 字体 PDF 提取可靠）
if out is None and ext == 'pdf':
    try:
        import fitz
        d = fitz.open(path)
        parts = []
        for p in d:
            t = p.get_text()
            if t:
                parts.append(t)
        if parts and sum(len(x) for x in parts) > 20:
            out = '\n'.join(parts)
    except Exception as e:
        print('pymupdf skip: %s' % e, file=sys.stderr)

# 3) 老式 .doc（Word 6/95/97-2003 二进制）：antiword → soffice 兜底
if out is None and ext == 'doc':
    try:
        r = subprocess.run(['antiword', '-m', 'UTF-8.txt', path],
                           capture_output=True, timeout=40)
        t = r.stdout.decode('utf-8', 'ignore')
        if r.returncode == 0 and len(t.strip()) > 20:
            out = t
        else:
            print('antiword skip: rc=%s' % r.returncode, file=sys.stderr)
    except Exception as e:
        print('antiword skip: %s' % e, file=sys.stderr)
    if out is None:
        try:
            os.makedirs('/tmp/conv', exist_ok=True)
            r = subprocess.run(
                ['soffice', '--headless', '-env:UserInstallation=file:///tmp/lo',
                 '--convert-to', 'txt:Text', '--outdir', '/tmp/conv', path],
                capture_output=True, timeout=55)
            txt = os.path.join('/tmp/conv', name.rsplit('.', 1)[0] + '.txt')
            if r.returncode == 0 and os.path.exists(txt):
                with open(txt, 'r', encoding='utf-8', errors='ignore') as f:
                    t = f.read()
                if len(t.strip()) > 20:
                    out = t
            else:
                print('soffice skip: rc=%s' % r.returncode, file=sys.stderr)
        except Exception as e:
            print('soffice skip: %s' % e, file=sys.stderr)

if not out:
    print('EXTRACT_EMPTY', file=sys.stderr)
    sys.exit(3)

try:
    os.makedirs('/out', exist_ok=True)
    with open('/out/extract.md', 'w', encoding='utf-8') as f:
        f.write(out)
except Exception as e:
    print('write fail: %s' % e, file=sys.stderr)
    sys.stdout.write(out)
    sys.exit(0)
print('EXTRACT_OK len=%d' % len(out))
`

// NewSandboxParser 构造注入用的沙箱解析器闭包。
func NewSandboxParser(cli *codex.Client) func(filename string, data []byte) (string, bool, error) {
	return func(filename string, data []byte) (string, bool, error) {
		text, handled := sandboxExtract(cli, filename, data)
		return text, handled, nil
	}
}

// sandboxExtract 用沙箱解析文档；仅当沙箱成功返回可信文本时 handled=true。
func sandboxExtract(cli *codex.Client, filename string, data []byte) (string, bool) {
	if cli == nil || !cli.Enabled() {
		return "", false
	}
	switch ExtOf(filename) {
	case "pdf", "docx", "pptx", "doc", "xls", "xlsx":
	default:
		return "", false // txt/csv/md 等本地直读更快的格式不走沙箱
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	resp, err := cli.Exec(ctx, codex.ExecRequest{
		Code:  sandboxExtractCode,
		Files: []codex.InFile{{Name: filename, Content: base64.StdEncoding.EncodeToString(data)}},
	})
	if err != nil || resp == nil || resp.TimedOut {
		log.Printf("[ingest-sandbox] %s: exec fail err=%v timedout=%v", filename, err, resp != nil && resp.TimedOut)
		return "", false
	}
	// 产物通道优先（规避 stdout 64KB 截断）；文本 artifact 原样返回，兼容 base64 编码
	for _, a := range resp.Artifacts {
		if a.Name == "extract.md" && a.Data != "" {
			b := []byte(a.Data)
			if dec, derr := base64.StdEncoding.DecodeString(a.Data); derr == nil {
				b = dec
			}
			if looksReadable(string(b)) {
				log.Printf("[ingest-sandbox] %s: artifact ok len=%d head=%q", filename, len(b), truncateRuneS(string(b), 40))
				return string(b), true
			}
			log.Printf("[ingest-sandbox] %s: artifact not readable len=%d", filename, len(b))
		}
	}
	// stdout 兜底：排除脚本状态行（写文件成功时 stdout 仅 "EXTRACT_OK…"，非解析文本）
	stdout := resp.Stdout
	if strings.HasPrefix(strings.TrimSpace(stdout), "EXTRACT_") {
		stdout = ""
	}
	if resp.ExitCode == 0 && looksReadable(stdout) {
		log.Printf("[ingest-sandbox] %s: stdout ok len=%d", filename, len(stdout))
		return stdout, true
	}
	log.Printf("[ingest-sandbox] %s: fallback none (exit=%d stdout=%q)", filename, resp.ExitCode, truncateRuneS(resp.Stdout, 50))
	return "", false
}

// truncateRuneS rune 安全截断（日志用）。
func truncateRuneS(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}