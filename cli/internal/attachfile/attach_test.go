package attachfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func write(t *testing.T, name string, data []byte) string {
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestPrepare(t *testing.T) {
	t.Setenv("HIVENOD_HOME", filepath.Join(t.TempDir(), "home"))
	p, err := Prepare(write(t, "a.html", []byte("<p>x</p>")), "", nil)
	if err != nil || p.Kind != "html" || p.Name != "a.html" || p.Content != "<p>x</p>" {
		t.Fatalf("%+v %v", p, err)
	}
	if p, _ := Prepare(write(t, "a.MD", []byte("# x")), "", nil); p.Kind != "markdown" {
		t.Fatal("md")
	}
	if p, _ := Prepare(write(t, "a.txt", []byte("x")), "Notes", nil); p.Name != "Notes" || p.Kind != "text" {
		t.Fatal("name")
	}
	if p, _ := Prepare(write(t, "a.png", []byte{1, 2, 3}), "", nil); p.Kind != "image" || p.Content != "data:image/png;base64,AQID" {
		t.Fatalf("png %+v", p)
	}
	if p, _ := Prepare(write(t, "a.pdf", []byte("x")), "", nil); p.Kind != "pdf" {
		t.Fatal("pdf")
	}
	if p, _ := Prepare("https://example.com/docs/report.pdf", "", nil); p.Kind != "link" || p.Name != "report.pdf" || p.URL != "https://example.com/docs/report.pdf" {
		t.Fatalf("link %+v", p)
	}
	if p, _ := Prepare("https://example.com", "", nil); p.Name != "example.com" {
		t.Fatalf("host %+v", p)
	}
	if _, err := Prepare(write(t, "a.exe", []byte("x")), "", nil); err == nil || !strings.Contains(err.Error(), "use html, md, txt") {
		t.Fatal(err)
	}
	if _, err := Prepare(write(t, "big.txt", make([]byte, MaxBytes+1)), "", nil); err == nil || !strings.Contains(err.Error(), "over the 900 KB limit") {
		t.Fatal(err)
	}
	if _, err := Prepare(write(t, "big.png", make([]byte, 700*1024)), "", nil); err == nil || !strings.Contains(err.Error(), "once encoded") {
		t.Fatal(err)
	}
	if _, err := Prepare(filepath.Join(t.TempDir(), "missing.txt"), "", nil); err == nil || !strings.HasPrefix(err.Error(), "File not found") {
		t.Fatal(err)
	}
}

func TestProtected(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	os.MkdirAll(home, 0o700)
	t.Setenv("HIVENOD_HOME", home)
	secret := filepath.Join(home, "agent.json")
	os.WriteFile(secret, []byte(`{"token":"x"}`), 0o600)
	// Rename to an allowed extension inside: still refused.
	inHome := filepath.Join(home, "notes.txt")
	os.WriteFile(inHome, []byte("x"), 0o600)
	work := t.TempDir()
	sym := filepath.Join(work, "link.txt")
	os.Symlink(inHome, sym)
	hard := filepath.Join(work, "hard.txt")
	if err := os.Link(inHome, hard); err != nil {
		t.Skip("no hard links here")
	}
	symDir := filepath.Join(work, "dir")
	os.Symlink(home, symDir)
	for _, p := range []string{inHome, sym, hard, filepath.Join(symDir, "notes.txt")} {
		if _, err := Prepare(p, "", nil); err == nil || err.Error() != ProtectedMessage {
			t.Errorf("%s: %v", p, err)
		}
	}
	if _, err := Prepare(write(t, "ok.txt", []byte("fine")), "", nil); err != nil {
		t.Fatal(err)
	}
	// A FIFO does not hang and is not a file.
	fifo := filepath.Join(work, "pipe.txt")
	if err := mkfifo(fifo); err == nil {
		if _, err := Prepare(fifo, "", nil); err == nil || !strings.Contains(err.Error(), "not a file") {
			t.Errorf("fifo: %v", err)
		}
	}
}
