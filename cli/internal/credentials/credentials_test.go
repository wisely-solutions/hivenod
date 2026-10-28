package credentials

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wisely-solutions/hivenod/cli/internal/discovery"
	"github.com/wisely-solutions/hivenod/cli/internal/token"
)

var tok = token.Prefix + base64.RawURLEncoding.EncodeToString([]byte(`{"p":"0123456789abcdefXYZ","w":"w1","e":"agent-abcdefghijkl@agents.hive-board.app"}`))

func TestSaveReadClear(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "h")
	t.Setenv("HIVENOD_HOME", dir)
	t.Setenv("HIVENOD_TOKEN", "")
	if s, _ := Inspect(); s != Missing {
		t.Fatalf("want missing, got %v", s)
	}
	file, err := Save(Stored{Token: tok, WorkspaceID: "w1", AgentUID: "a1", AgentName: "Bee"})
	if err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(file)
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("file mode %v", st.Mode().Perm())
	}
	ds, _ := os.Stat(dir)
	if ds.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", ds.Mode().Perm())
	}
	// Same format as the TypeScript CLI.
	var m map[string]any
	raw, _ := os.ReadFile(file)
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"token", "workspaceId", "agentUid", "agentName", "savedAt"} {
		if _, ok := m[k]; !ok {
			t.Fatalf("missing key %s", k)
		}
	}
	got, src, err := Resolve()
	if err != nil || got != tok || src != FromFile {
		t.Fatalf("resolve: %v %v", src, err)
	}
	t.Setenv("HIVENOD_TOKEN", "env-token")
	if got, src, _ := Resolve(); got != "env-token" || src != FromEnv {
		t.Fatal("env must win")
	}
	had, err := Clear()
	if !had || err != nil {
		t.Fatalf("clear: %v %v", had, err)
	}
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("file still there")
	}
	if had, _ := Clear(); had {
		t.Fatal("second clear should say none")
	}
}

func TestDamaged(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("HIVENOD_HOME", dir)
	t.Setenv("HIVENOD_TOKEN", "")
	for _, body := range []string{"not json", `{"token":5}`, `{"token":"hive_agt_bad"}`, "null"} {
		os.WriteFile(filepath.Join(dir, "agent.json"), []byte(body), 0o600)
		if s, _ := Inspect(); s != Damaged {
			t.Fatalf("%q: want damaged", body)
		}
		if _, _, err := Resolve(); err != ErrDamaged {
			t.Fatalf("%q: resolve should be ErrDamaged", body)
		}
	}
	// A file written by the TypeScript CLI reads back.
	os.WriteFile(filepath.Join(dir, "agent.json"), []byte(`{
  "token": "`+tok+`",
  "workspaceId": "w1",
  "agentUid": "a1",
  "agentName": "Bee",
  "savedAt": "2026-10-27T10:00:00.000Z"
}
`), 0o600)
	if s, c := Inspect(); s != OK || c.AgentName != "Bee" || c.SavedAt != "2026-10-27T10:00:00.000Z" {
		t.Fatalf("ts file: %v %+v", s, c)
	}
}

func TestServerSavedWithToken(t *testing.T) {
	t.Setenv("HIVENOD_HOME", filepath.Join(t.TempDir(), "h"))
	d := &discovery.Discovery{Protocol: 1, Backend: "firestore", Site: "https://your.host", CLI: "https://your.host/cli",
		Firebase: discovery.Firebase{APIKey: "k", AuthDomain: "your.host", ProjectID: "p"}}
	if _, err := Save(Stored{Token: tok, AgentName: "Bee", Server: d.Site, Discovery: d}); err != nil {
		t.Fatal(err)
	}
	c := Read()
	if c == nil || c.Server != "https://your.host" || c.Discovery == nil || c.Discovery.Firebase.ProjectID != "p" {
		t.Fatalf("got %+v", c)
	}
	// A file without a server (every pairing before servers existed) means the hosted service.
	if _, err := Save(Stored{Token: tok, AgentName: "Bee"}); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(Path())
	if strings.Contains(string(raw), "server") || strings.Contains(string(raw), "discovery") {
		t.Fatalf("hosted pairing must not write a server: %s", raw)
	}
	if c := Read(); c == nil || c.Server != "" || c.Discovery != nil {
		t.Fatalf("got %+v", c)
	}
	write := func(extra string) {
		if err := os.WriteFile(Path(), []byte(`{"token":"`+tok+`",`+extra+`}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	// The hosted service written out is the same as no server.
	write(`"server":"https://hivenod.com/"`)
	if c := Read(); c == nil || c.Server != "" {
		t.Fatalf("got %+v", c)
	}
	// A saved discovery for another site is dropped (read anew), the server is kept.
	write(`"server":"your.host","discovery":{"protocol":1,"backend":"firestore","site":"https://other.host","firebase":{"apiKey":"k","authDomain":"a","projectId":"p"},"cli":"x"}`)
	if c := Read(); c == nil || c.Server != "https://your.host" || c.Discovery != nil {
		t.Fatalf("got %+v", c)
	}
	// Emulators never stick to a public site.
	write(`"server":"your.host","discovery":{"protocol":1,"backend":"firestore","site":"https://your.host","firebase":{"apiKey":"k","authDomain":"a","projectId":"p"},"cli":"x","emulators":{"auth":"127.0.0.1:9099"}}`)
	if c := Read(); c == nil || c.Discovery == nil || c.Discovery.Emulators != nil {
		t.Fatalf("got %+v", c)
	}
	// An unusable server makes the file damaged.
	write(`"server":"http://your.host"`)
	if s, _ := Inspect(); s != Damaged {
		t.Fatalf("want damaged, got %v", s)
	}
}
