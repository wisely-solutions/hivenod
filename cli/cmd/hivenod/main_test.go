package main

import (
	"bytes"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/token"
)

func call(args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := run(args, strings.NewReader(""), &out, &errb)
	return code, out.String(), errb.String()
}

var tok = token.Prefix + base64.RawURLEncoding.EncodeToString([]byte(`{"p":"0123456789abcdefXYZ","w":"w1","e":"agent-abcdefghijkl@agents.hive-board.app"}`))

func TestCommands(t *testing.T) {
	t.Setenv("HIVENOD_HOME", filepath.Join(t.TempDir(), "h"))
	t.Setenv("HIVENOD_TOKEN", "")
	if code, out, _ := call("--version"); code != 0 || !strings.HasPrefix(out, "hivenod ") {
		t.Fatalf("version: %d %q", code, out)
	}
	if code, out, _ := call("version"); code != 0 || !strings.HasPrefix(out, "hivenod ") {
		t.Fatal("version word")
	}
	if code, out, _ := call(); code != 0 || !strings.Contains(out, "hivenod pair") {
		t.Fatal("help")
	}
	if code, _, errs := call("frobnicate"); code != 2 || !strings.Contains(errs, "unknown command") {
		t.Fatal("unknown")
	}
	if _, out, _ := call("logout"); !strings.Contains(out, "No saved token") {
		t.Fatal(out)
	}
	if _, err := credentials.Save(credentials.Stored{Token: tok, WorkspaceID: "w1", AgentUID: "a", AgentName: "Bee"}); err != nil {
		t.Fatal(err)
	}
	if code, out, _ := call("pair"); code != 0 || !strings.Contains(out, "Already paired") {
		t.Fatalf("pair when paired: %q", out)
	}
	if code, out, _ := call("logout"); code != 0 || !strings.Contains(out, "Removed the saved token") {
		t.Fatal(out)
	}
	if _, err := os.Stat(credentials.Path()); !os.IsNotExist(err) {
		t.Fatal("token file still there")
	}
	t.Setenv("HIVENOD_TOKEN", tok)
	if _, out, _ := call("pair"); !strings.Contains(out, "HIVENOD_TOKEN is set") {
		t.Fatal(out)
	}
	t.Setenv("HIVENOD_TOKEN", "")
	if code, _, errs := call("mcp"); code != 1 || !strings.Contains(errs, "not paired") {
		t.Fatalf("mcp unpaired: %d %q", code, errs)
	}
	if code, _, errs := call("whoami", "--json"); code != 1 || !strings.HasPrefix(errs, `{"error":`) {
		t.Fatalf("whoami json error: %q", errs)
	}
	t.Setenv("HIVENOD_TOKEN", tok)
	if code, _, errs := call("mcp", "--max-items", "2"); code != 1 || !strings.Contains(errs, "--max-items needs hivenod mcp --channel") {
		t.Fatalf("max-items: %q", errs)
	}
	if code, _, errs := call("mcp", "--channel", "--max-items", "11"); code != 1 || !strings.Contains(errs, "from 1 to 10") {
		t.Fatalf("max-items range: %q", errs)
	}
}

func TestServerFlag(t *testing.T) {
	t.Setenv("HIVENOD_HOME", filepath.Join(t.TempDir(), "h"))
	t.Setenv("HIVENOD_TOKEN", "")
	t.Setenv("HIVENOD_WEB_URL", "")
	if code, _, errs := call("whoami", "--server", "https://your.host"); code != 2 || !strings.Contains(errs, "--server goes with connect or pair") {
		t.Fatalf("whoami --server: %d %q", code, errs)
	}
	if code, _, errs := call("pair", "--server", "http://your.host"); code != 1 || !strings.Contains(errs, "must use https") {
		t.Fatalf("pair --server http: %d %q", code, errs)
	}
	if code, out, _ := call("--help"); code != 0 || !strings.Contains(out, "--server https://your.host") {
		t.Fatal("help names --server")
	}
	// Already connected: --server does not read the site, it says who this machine is.
	if _, err := credentials.Save(credentials.Stored{Token: tok, AgentName: "Bee", Server: "https://your.host"}); err != nil {
		t.Fatal(err)
	}
	if code, out, _ := call("pair", "--server", "https://other.host"); code != 0 || !strings.Contains(out, "Already paired") {
		t.Fatalf("pair when paired: %d %q", code, out)
	}
}
