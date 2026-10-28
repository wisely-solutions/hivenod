// Package update is `hivenod version` and `hivenod update`. A release publishes, under
// <site>/cli/bin/: latest.json (the manifest) and, per version, one binary per target with a
// SHA-256 checksum next to it. update downloads the binary for this machine, checks the checksum
// against the manifest and the .sha256 file, and replaces the running binary in place.
package update

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Set at build time: -ldflags "-X .../update.Version=0.1.123 -X .../update.Commit=<sha>".
var (
	Version = "0.0.0"
	Commit  = ""
)

// Line is what `hivenod --version` prints.
func Line() string {
	if Commit != "" {
		c := Commit
		if len(c) > 7 {
			c = c[:7]
		}
		return fmt.Sprintf("hivenod %s (commit %s)", Version, c)
	}
	return "hivenod " + Version
}

// Target is this machine's release target name: linux-x64, linux-arm64, darwin-x64,
// darwin-arm64, windows-x64.
func Target() string { return TargetFor(runtime.GOOS, runtime.GOARCH) }

// TargetFor maps GOOS/GOARCH to a target name ("" when there is no release for it).
func TargetFor(goos, goarch string) string {
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[goarch]
	if arch == "" {
		return ""
	}
	switch goos {
	case "linux", "darwin":
		return goos + "-" + arch
	case "windows":
		if arch == "x64" {
			return "windows-x64"
		}
	}
	return ""
}

// File is one binary in the manifest.
type File struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

// Manifest is <site>/cli/bin/latest.json.
type Manifest struct {
	Version     string          `json:"version"`
	Commit      string          `json:"commit"`
	CLIProtocol int             `json:"cliProtocol"`
	Files       map[string]File `json:"files"`
}

// Newer reports whether version a is newer than b (dotted numbers).
func Newer(a, b string) bool {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// Updater talks to the site.
type Updater struct {
	Site string // e.g. https://hivenod.com
	HTTP *http.Client
	// Exe is the binary to replace (default: the running one).
	Exe string
	Say func(string)
}

func (u *Updater) client() *http.Client {
	if u.HTTP != nil {
		return u.HTTP
	}
	return &http.Client{Timeout: 5 * time.Minute}
}

func (u *Updater) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := u.client().Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", u.Site, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", url, res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s is larger than expected", url)
	}
	return b, nil
}

// Latest reads the manifest.
func (u *Updater) Latest(ctx context.Context) (*Manifest, error) {
	b, err := u.get(ctx, strings.TrimRight(u.Site, "/")+"/cli/bin/latest.json?t="+strconv.FormatInt(time.Now().UnixMilli(), 10), 1<<20)
	if err != nil {
		return nil, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil || m.Version == "" {
		return nil, errors.New("the release manifest could not be read")
	}
	return &m, nil
}

// ErrChecksum means the download does not match the published checksum.
var ErrChecksum = errors.New("the downloaded binary does not match its published SHA-256 checksum; nothing was changed")

// Run checks for a newer release and installs it. force reinstalls the same version.
func (u *Updater) Run(ctx context.Context, force bool) (string, error) {
	say := u.Say
	if say == nil {
		say = func(string) {}
	}
	m, err := u.Latest(ctx)
	if err != nil {
		return "", err
	}
	if !force && !Newer(m.Version, Version) {
		return fmt.Sprintf("hivenod %s is the latest version.", Version), nil
	}
	t := Target()
	f, ok := m.Files[t]
	if !ok || f.Path == "" || len(f.SHA256) != 64 {
		return "", fmt.Errorf("release %s has no binary for this machine (%s)", m.Version, t)
	}
	base := strings.TrimRight(u.Site, "/") + "/" + strings.TrimLeft(f.Path, "/")
	say(fmt.Sprintf("Downloading hivenod %s for %s…", m.Version, t))
	bin, err := u.get(ctx, base, 512<<20)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(bin)
	got := hex.EncodeToString(sum[:])
	side, err := u.get(ctx, base+".sha256", 4096)
	if err != nil {
		return "", err
	}
	published := strings.Fields(string(side))
	if got != strings.ToLower(f.SHA256) || len(published) == 0 || strings.ToLower(published[0]) != got {
		return "", ErrChecksum
	}
	exe := u.Exe
	if exe == "" {
		if exe, err = os.Executable(); err != nil {
			return "", err
		}
		if r, err := filepath.EvalSymlinks(exe); err == nil {
			exe = r
		}
	}
	if err := Replace(exe, bin); err != nil {
		return "", fmt.Errorf("could not replace %s: %w", exe, err)
	}
	return fmt.Sprintf("Updated hivenod %s -> %s (%s). Restart running sessions to use it.", Version, m.Version, exe), nil
}

// Replace swaps the file at exe for bin atomically (same folder, then rename). On Windows the
// running binary cannot be overwritten, so it is moved aside first.
func Replace(exe string, bin []byte) error {
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".hivenod-update-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	if err := os.Chmod(name, 0o755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return err
		}
		if err := os.Rename(name, exe); err != nil {
			_ = os.Rename(old, exe)
			return err
		}
		return nil
	}
	return os.Rename(name, exe)
}
