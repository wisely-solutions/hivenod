//go:build windows

package attachfile

import "errors"

func mkfifo(string) error { return errors.New("no fifo") }
