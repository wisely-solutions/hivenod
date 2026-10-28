//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
)

// runClaude runs Claude Code in this console and exits with its code (Windows has no exec).
func runClaude(argv []string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	cmd.Env = withHivenodOnPath(os.Environ())
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		os.Exit(exit.ExitCode())
	}
	if err != nil {
		return err
	}
	os.Exit(0)
	return nil
}
