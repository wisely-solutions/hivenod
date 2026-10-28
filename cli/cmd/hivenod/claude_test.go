//go:build !windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
)

// fakeClaude puts a `claude` on PATH that appends its arguments to a log, and returns the log.
func fakeClaude(t *testing.T, exit int) string {
	t.Helper()
	dir := t.TempDir()
	log := filepath.Join(dir, "calls.log")
	script := "#!/bin/sh\necho \"$*\" >> " + log + "\necho done\nexit " + string(rune('0'+exit)) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	return log
}

func TestClaudeSetup(t *testing.T) {
	log := fakeClaude(t, 0)
	var said []string
	if err := claudeSetup(func(s string) { said = append(said, s) }); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(log)
	want := "plugin marketplace add wisely-solutions/hivenod\nplugin install hivenod@hivenod\n"
	if string(got) != want {
		t.Fatalf("calls:\n%s", got)
	}
	if !strings.Contains(strings.Join(said, "\n"), "Claude Code has the hivenod plugin") {
		t.Fatal(said)
	}

	t.Setenv("HIVENOD_PLUGIN_MARKETPLACE", "/src/hivenod")
	_ = os.Remove(log)
	if err := claudeSetup(func(string) {}); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(log); !strings.HasPrefix(string(got), "plugin marketplace add /src/hivenod\n") {
		t.Fatalf("override: %s", got)
	}
}

func TestClaudeSetupFails(t *testing.T) {
	fakeClaude(t, 1)
	err := claudeSetup(func(string) {})
	if err == nil || !strings.Contains(err.Error(), "claude plugin marketplace add") {
		t.Fatalf("%v", err)
	}
	t.Setenv("PATH", t.TempDir())
	if err := claudeSetup(func(string) {}); err != errNoClaude {
		t.Fatalf("no claude: %v", err)
	}
	if _, err := claudeCommand(nil); err != errNoClaude {
		t.Fatal(err)
	}
}

func TestClaudeCommand(t *testing.T) {
	fakeClaude(t, 0)
	argv, err := claudeCommand([]string{"--model", "haiku"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(argv[0], "/claude") ||
		strings.Join(argv[1:], " ") != "--dangerously-load-development-channels plugin:hivenod@hivenod --model haiku" {
		t.Fatalf("%q", argv)
	}
}

func TestWithHivenodOnPath(t *testing.T) {
	exe, _ := os.Executable()
	env := withHivenodOnPath([]string{"HOME=/h", "PATH=/usr/bin"})
	if env[1] != "PATH="+filepath.Dir(exe)+":/usr/bin" || env[0] != "HOME=/h" {
		t.Fatalf("%q", env)
	}
	if env := withHivenodOnPath([]string{"HOME=/h"}); env[1] != "PATH="+filepath.Dir(exe) {
		t.Fatalf("%q", env)
	}
}

func TestConnectWhenConnectedSetsUpClaude(t *testing.T) {
	log := fakeClaude(t, 0)
	t.Setenv("HIVENOD_HOME", filepath.Join(t.TempDir(), "h"))
	t.Setenv("HIVENOD_TOKEN", "")
	if _, err := credentials.Save(credentials.Stored{Token: tok, WorkspaceID: "w1", AgentUID: "a", AgentName: "Bee"}); err != nil {
		t.Fatal(err)
	}
	code, out, errs := call("connect")
	if code != 0 {
		t.Fatalf("%d %s %s", code, out, errs)
	}
	for _, w := range []string{"Already connected as Bee", "Claude Code has the hivenod plugin", "Start it with: hivenod claude"} {
		if !strings.Contains(out, w) {
			t.Fatalf("missing %q in %s", w, out)
		}
	}
	if got, _ := os.ReadFile(log); !strings.Contains(string(got), "plugin install hivenod@hivenod") {
		t.Fatal(string(got))
	}
	if strings.Contains(out, tok) {
		t.Fatal("token printed")
	}
}
