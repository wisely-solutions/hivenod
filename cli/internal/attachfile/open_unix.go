//go:build !windows

package attachfile

import (
	"os"
	"strconv"
	"syscall"
)

// openNoFollow opens without following a final symlink and without blocking on a FIFO.
func openNoFollow(p string) (*os.File, error) {
	return os.OpenFile(p, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
}

// fdPath is the opened file's own path (Linux), "" elsewhere.
func fdPath(f *os.File) string {
	p, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd())))
	if err != nil {
		return ""
	}
	return p
}
