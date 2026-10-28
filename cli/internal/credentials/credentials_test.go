package credentials

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

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
