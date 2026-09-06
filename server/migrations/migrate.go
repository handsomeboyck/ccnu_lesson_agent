// Package migrations 内嵌并执行 SQL 迁移（go:embed 同目录 *.sql）。
// 迁移按文件名排序执行；语句需幂等（IF NOT EXISTS）以支持重复启动。
package migrations

import (
	"context"
	"embed"
	"fmt"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed *.sql
var files embed.FS

// Run 依序执行全部迁移脚本。因 pgx 扩展协议不允许单条 Exec 含多条语句，
// 先把脚本按 ";" 拆分为单条语句，放入同一事务逐条执行。
func Run(ctx context.Context, pool *pgxpool.Pool) error {
	entries, err := files.ReadDir(".")
	if err != nil {
		return err
	}
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	tx, err := pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("migrations begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	for _, name := range names {
		sqlBytes, err := files.ReadFile(name)
		if err != nil {
			return err
		}
		for _, stmt := range splitStatements(string(sqlBytes)) {
			if _, err := tx.Exec(ctx, stmt); err != nil {
				return fmt.Errorf("migrate %s: %w\nstatement: %s", name, err, truncate(stmt, 200))
			}
		}
	}
	return tx.Commit(ctx)
}

// splitStatements 简单拆分：忽略 -- 注释行与空行，按 ";" 结束切分语句。
func splitStatements(sql string) []string {
	var out []string
	var cur strings.Builder
	for _, line := range strings.Split(sql, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		cur.WriteString(line)
		cur.WriteString("\n")
		if strings.HasSuffix(strings.TrimSpace(line), ";") {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	if s := strings.TrimSpace(cur.String()); s != "" {
		out = append(out, s)
	}
	return out
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}
