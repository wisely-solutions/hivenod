package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func site(t *testing.T, version string, bin []byte, sum string, sideSum string) *httptest.Server {
	mux := http.NewServeMux()
	path := "/cli/bin/" + version + "/hivenod-" + Target()
	mux.HandleFunc("/cli/bin/latest.json", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(Manifest{Version: version, Commit: "abc", CLIProtocol: 2, Files: map[string]File{
			Target(): {Name: "hivenod-" + Target(), Path: path, SHA256: sum, Size: int64(len(bin))},
		}})
	})
	mux.HandleFunc(path, func(w http.ResponseWriter, _ *http.Request) { w.Write(bin) })
	mux.HandleFunc(path+".sha256", func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(sideSum + "  hivenod-" + Target() + "\n"))
	})
	s := httptest.NewServer(mux)
	t.Cleanup(s.Close)
	return s
}

func hash(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func TestUpdate(t *testing.T) {
	Version = "0.1.10"
	exe := filepath.Join(t.TempDir(), "hivenod")
	os.WriteFile(exe, []byte("old"), 0o755)
	bin := []byte("new binary")

	s := site(t, "0.1.11", bin, hash(bin), hash(bin))
	u := &Updater{Site: s.URL, Exe: exe}
	msg, err := u.Run(context.Background(), false)
	if err != nil || !strings.Contains(msg, "0.1.10 -> 0.1.11") {
		t.Fatalf("%q %v", msg, err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new binary" {
		t.Fatal("not replaced")
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o100 == 0 {
		t.Fatal("not executable")
	}

	// Same version: nothing to do.
	Version = "0.1.11"
	if msg, _ := u.Run(context.Background(), false); !strings.Contains(msg, "latest") {
		t.Fatal(msg)
	}

	// A bad checksum (manifest or side file) changes nothing.
	Version = "0.1.10"
	os.WriteFile(exe, []byte("old"), 0o755)
	for _, s := range []*httptest.Server{
		site(t, "0.1.12", bin, strings.Repeat("0", 64), hash(bin)),
		site(t, "0.1.12", bin, hash(bin), strings.Repeat("0", 64)),
	} {
		_, err := (&Updater{Site: s.URL, Exe: exe}).Run(context.Background(), false)
		if err != ErrChecksum {
			t.Fatalf("want checksum error, got %v", err)
		}
		if b, _ := os.ReadFile(exe); string(b) != "old" {
			t.Fatal("binary changed despite a bad checksum")
		}
	}
}

func TestVersionHelpers(t *testing.T) {
	if !Newer("0.2.103", "0.2.9") || Newer("0.2.9", "0.2.103") || !Newer("0.2.10", "0.2.9") {
		t.Fatal("Newer numeric: 0.2.9 -> 0.2.103")
	}
	if !Newer("0.1.10", "0.1.9") || Newer("0.1.9", "0.1.10") || Newer("0.1.9", "0.1.9") {
		t.Fatal("Newer")
	}
	for in, want := range map[[2]string]string{
		{"linux", "amd64"}: "linux-x64", {"linux", "arm64"}: "linux-arm64", {"darwin", "amd64"}: "darwin-x64",
		{"darwin", "arm64"}: "darwin-arm64", {"windows", "amd64"}: "windows-x64", {"windows", "arm64"}: "", {"freebsd", "amd64"}: "",
	} {
		if got := TargetFor(in[0], in[1]); got != want {
			t.Errorf("%v: %q", in, got)
		}
	}
	Version, Commit = "0.1.5", "0123456789abcdef"
	if Line() != "hivenod 0.1.5 (commit 0123456)" {
		t.Fatal(Line())
	}
	Commit = ""
	if Line() != "hivenod 0.1.5" {
		t.Fatal(Line())
	}
}

func TestNotice(t *testing.T) {
	Version = "0.1.10"
	dir := t.TempDir()
	hits := 0
	mux := http.NewServeMux()
	latest := "0.1.12"
	mux.HandleFunc("/cli/bin/latest.json", func(w http.ResponseWriter, _ *http.Request) {
		hits++
		json.NewEncoder(w).Encode(Manifest{Version: latest})
	})
	s := httptest.NewServer(mux) // a fake latest.json; never the network
	defer s.Close()
	u := &Updater{Site: s.URL}
	now := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)

	msg := u.Notice(context.Background(), dir, now)
	if !strings.Contains(msg, "0.1.12") || !strings.Contains(msg, "hivenod update") {
		t.Fatalf("%q", msg)
	}
	// Within a day: no new check, no repeat.
	if m := u.Notice(context.Background(), dir, now.Add(23*time.Hour)); m != "" || hits != 1 {
		t.Fatalf("repeated: %q hits=%d", m, hits)
	}
	// After a day: tells again.
	if m := u.Notice(context.Background(), dir, now.Add(25*time.Hour)); m == "" || hits != 2 {
		t.Fatalf("not repeated after a day: %q hits=%d", m, hits)
	}
	// Up to date: silent, but the check counts.
	latest = "0.1.10"
	if m := u.Notice(context.Background(), dir, now.Add(60*time.Hour)); m != "" || hits != 3 {
		t.Fatalf("up to date said %q hits=%d", m, hits)
	}
	// Unreachable: silent and not counted.
	dir2 := t.TempDir()
	dead := &Updater{Site: "http://127.0.0.1:1"}
	if m := dead.Notice(context.Background(), dir2, now); m != "" {
		t.Fatal(m)
	}
	if _, err := os.Stat(filepath.Join(dir2, NoticeFile)); err == nil {
		t.Fatal("a failed check was recorded")
	}
	// A development build says nothing and asks nothing.
	Version = "0.0.0"
	before := hits
	if m := u.Notice(context.Background(), t.TempDir(), now); m != "" || hits != before {
		t.Fatal("dev build checked")
	}
}
