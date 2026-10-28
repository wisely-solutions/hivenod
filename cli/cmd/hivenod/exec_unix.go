//go:build !windows

package main

import (
	"os"
	"syscall"
)

// runClaude replaces this process with Claude Code, so it owns the terminal and its signals.
func runClaude(argv []string) error {
	return syscall.Exec(argv[0], argv, withHivenodOnPath(os.Environ()))
}
