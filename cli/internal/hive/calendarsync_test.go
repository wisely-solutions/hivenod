package hive

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseFeed(t *testing.T) {
	f, err := ParseFeed([]byte(`{"kind":"calendar#events","items":[{"id":"a","summary":"S","start":{"dateTime":"2030-01-07T09:00:00Z"}}],"nextSyncToken":"tok"}`), "x.json")
	if err != nil || len(f.Items) != 1 || *f.Items[0].ID != "a" || f.NextSyncToken == nil || *f.NextSyncToken != "tok" {
		t.Fatalf("list: %+v %v", f, err)
	}
	f, err = ParseFeed([]byte(`[{"id":"a"},{"id":"b"}]`), "x.json")
	if err != nil || len(f.Items) != 2 || f.NextSyncToken != nil {
		t.Fatalf("array: %+v %v", f, err)
	}
	for _, bad := range []string{`nope`, `{"events":[]}`, `42`} {
		if _, err := ParseFeed([]byte(bad), "x.json"); err == nil || !strings.HasPrefix(Message(err), "x.json: ") {
			t.Errorf("%s: %v", bad, err)
		}
	}
}

func TestSaveSyncState(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	if err := SaveSyncState(p, CalendarSyncOut{Source: "google", Member: "u1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(p); !os.IsNotExist(err) {
		t.Fatal("no token: nothing written")
	}
	tok := "tok-9"
	if err := SaveSyncState(p, CalendarSyncOut{Source: "google", Member: "u1", NextSyncToken: &tok}); err != nil {
		t.Fatal(err)
	}
	st, _ := os.Stat(p)
	b, _ := os.ReadFile(p)
	if st.Mode().Perm() != 0o600 || !strings.Contains(string(b), `"syncToken": "tok-9"`) {
		t.Fatalf("%v %s", st.Mode(), b)
	}
}
