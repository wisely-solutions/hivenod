package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Claude Code setup (item EJ2Cxq4k): `hivenod connect` adds the hivenod plugin marketplace and
// installs the plugin (it carries the channel: `hivenod mcp --channel`), and `hivenod claude`
// starts Claude Code with that channel loaded.

// Marketplace is where Claude Code finds the hivenod plugin; HIVENOD_PLUGIN_MARKETPLACE points
// it at a local clone (the smoke) or a fork.
func marketplace() string {
	if m := os.Getenv("HIVENOD_PLUGIN_MARKETPLACE"); m != "" {
		return m
	}
	return "wisely-solutions/hivenod"
}

// Plugin is the plugin id, and ChannelArgs what loads its channel. The flag stays until Anthropic
// puts the plugin on Claude Code's approved channel list.
const plugin = "hivenod@hivenod"

var channelArgs = []string{"--dangerously-load-development-channels", "plugin:" + plugin}

const claudeInstallDocs = "https://docs.claude.com/en/docs/claude-code/setup"

var errNoClaude = errors.New("Claude Code (the claude command) is not installed. Install it (" + claudeInstallDocs + "), then run hivenod connect again.")

// claudeSetup adds the marketplace and installs the plugin. Both commands are idempotent, so
// running connect again on a set-up machine changes nothing.
func claudeSetup(say func(string)) error {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return errNoClaude
	}
	say("Setting up Claude Code: the hivenod plugin and its channel…")
	for _, args := range [][]string{
		{"plugin", "marketplace", "add", marketplace()},
		{"plugin", "install", plugin},
	} {
		var out bytes.Buffer
		cmd := exec.Command(bin, args...)
		cmd.Stdout, cmd.Stderr = &out, &out
		cmd.Env = withHivenodOnPath(os.Environ())
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("claude %s failed: %s", strings.Join(args, " "), strings.TrimSpace(lastLines(out.String(), 5)))
		}
	}
	say("✓ Claude Code has the hivenod plugin.")
	return nil
}

// claudeCommand is what `hivenod claude [args]` runs.
func claudeCommand(args []string) ([]string, error) {
	bin, err := exec.LookPath("claude")
	if err != nil {
		return nil, errNoClaude
	}
	return append(append([]string{bin}, channelArgs...), args...), nil
}

// withHivenodOnPath puts this binary's folder first on PATH, so the plugin finds `hivenod` even
// when the install folder is not on the PATH yet (a fresh install, a new Windows PATH).
func withHivenodOnPath(env []string) []string {
	exe, err := os.Executable()
	if err != nil {
		return env
	}
	dir := filepath.Dir(exe)
	out := make([]string, 0, len(env)+1)
	found := false
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if strings.EqualFold(k, "PATH") {
			found = true
			kv = k + "=" + dir + string(os.PathListSeparator) + v
		}
		out = append(out, kv)
	}
	if !found {
		out = append(out, "PATH="+dir)
	}
	return out
}

// interactive is true when both ends of the terminal are a person (not a pipe or a test).
func interactive() bool {
	for _, f := range []*os.File{os.Stdin, os.Stdout} {
		fi, err := f.Stat()
		if err != nil || fi.Mode()&os.ModeCharDevice == 0 {
			return false
		}
	}
	return true
}

func lastLines(s string, n int) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, "\n")
}
