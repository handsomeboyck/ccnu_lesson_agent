//go:build !linux

package main

// readDiskUsage 非 Linux（本地开发构建）占位：无法 statfs /host，保持零值。
func readDiskUsage(h *HostSnapshot) {}
