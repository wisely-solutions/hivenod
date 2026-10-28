//go:build windows

package attachfile

import "os"

func openNoFollow(p string) (*os.File, error) { return os.Open(p) }

func fdPath(*os.File) string { return "" }
