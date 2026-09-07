//go:build linux

package main

import "syscall"

// readDiskUsage 用 statfs 读宿主根挂载点 /host 的空间（未挂载则静默返回）。
func readDiskUsage(h *HostSnapshot) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(hostRoot, &st); err != nil {
		return
	}
	h.DiskTotalKB = int64(st.Blocks) * int64(st.Bsize) / 1024
	h.DiskFreeKB = int64(st.Bavail) * int64(st.Bsize) / 1024
	if h.DiskTotalKB > 0 {
		used := h.DiskTotalKB - h.DiskFreeKB
		h.DiskUsePct = float64(used) / float64(h.DiskTotalKB) * 100
	}
}
