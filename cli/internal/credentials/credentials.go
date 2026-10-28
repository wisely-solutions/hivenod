// Package credentials keeps a paired terminal's agent token in ~/.hivenod/agent.json
// (HIVENOD_HOME overrides the folder), in the same format as the TypeScript CLI so existing
// pairings keep working. The folder is 0700, the file 0600, written atomically. The token is never
// printed: commands show only the agent's name and the file path. HIVENOD_TOKEN still wins.
package credentials

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/discovery"
	"github.com/wisely-solutions/hivenod/cli/internal/token"
)

// Stored is what agent.json holds.
type Stored struct {
	Token       string `json:"token"`
	WorkspaceID string `json:"workspaceId"`
	AgentUID    string `json:"agentUid"`
	AgentName   string `json:"agentName"`
	SavedAt     string `json:"savedAt"`
	// Server is the self-hosted Hivenod this token belongs to (item 07W4gCboOicS0lM1bqwZ), with its
	// discovery file as read when connecting. Both are absent for https://hivenod.com, so files
	// saved before servers existed mean the hosted service, as they always did.
	Server    string               `json:"server,omitempty"`
	Discovery *discovery.Discovery `json:"discovery,omitempty"`
}

// Home is the folder of the saved pairing.
func Home() string {
	if h := os.Getenv("HIVENOD_HOME"); h != "" {
		return h
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	return filepath.Join(home, ".hivenod")
}

// Path is the saved pairing file.
func Path() string { return filepath.Join(Home(), "agent.json") }

// DamagedMessage is shown when the saved file exists but cannot be used.
func DamagedMessage() string {
	return fmt.Sprintf("The saved pairing in %s is damaged; run `hivenod pair` again.", Path())
}

// State of the saved file.
type State int

const (
	Missing State = iota
	Damaged
	OK
)

// Inspect tells a missing file apart from an unreadable or corrupted one.
func Inspect() (State, *Stored) {
	raw, err := os.ReadFile(Path())
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Missing, nil
		}
		return Damaged, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil || m == nil {
		return Damaged, nil
	}
	tok, ok := m["token"].(string)
	if !ok {
		return Damaged, nil
	}
	if _, err := token.Decode(tok); err != nil {
		return Damaged, nil
	}
	str := func(k string) string {
		switch v := m[k].(type) {
		case nil:
			return ""
		case string:
			return v
		case float64:
			return strconv.FormatFloat(v, 'f', -1, 64)
		case bool:
			return strconv.FormatBool(v)
		default:
			b, _ := json.Marshal(v)
			return string(b)
		}
	}
	out := &Stored{Token: tok, WorkspaceID: str("workspaceId"), AgentUID: str("agentUid"), AgentName: str("agentName"), SavedAt: str("savedAt")}
	if srv, ok := m["server"].(string); ok && srv != "" {
		site, err := discovery.NormalizeSite(srv)
		if err != nil {
			return Damaged, nil
		}
		if !discovery.IsHosted(site) {
			out.Server = site
			out.Discovery = storedDiscovery(site, m["discovery"])
		}
	}
	return OK, out
}

// storedDiscovery checks the saved copy of a discovery file again; nil (read it anew) when it
// does not fit the server.
func storedDiscovery(site string, v any) *discovery.Discovery {
	if v == nil {
		return nil
	}
	b, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	var d discovery.Discovery
	if json.Unmarshal(b, &d) != nil || d.Site != site || d.Backend != "firestore" || d.Protocol < 1 || d.Protocol > discovery.Protocol ||
		d.Firebase.APIKey == "" || d.Firebase.ProjectID == "" || d.Firebase.AuthDomain == "" {
		return nil
	}
	if d.Emulators != nil && !discovery.IsLoopback(site) {
		d.Emulators = nil
	}
	return &d
}

// Read returns the saved credentials, or nil when there are none or they are unusable.
func Read() *Stored {
	if s, c := Inspect(); s == OK {
		return c
	}
	return nil
}

// Save writes the pairing atomically and returns the file path.
func Save(c Stored) (string, error) {
	dir := Home()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", err
	}
	c.SavedAt = time.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return "", err
	}
	file := Path()
	tmp := file + "." + strconv.Itoa(os.Getpid()) + ".tmp"
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return file, os.Chmod(file, 0o600)
}

// Shred overwrites a file with random bytes, flushes it, then deletes it, so the token does not
// stay readable in freed disk blocks (best effort on copy-on-write file systems, like any shred).
func Shred(file string) error {
	f, err := os.OpenFile(file, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	st, err := f.Stat()
	if err == nil {
		buf := make([]byte, 64*1024)
		for pos := int64(0); pos < st.Size(); {
			n := int64(len(buf))
			if st.Size()-pos < n {
				n = st.Size() - pos
			}
			_, _ = rand.Read(buf[:n])
			w, werr := f.WriteAt(buf[:n], pos)
			if werr != nil {
				err = werr
				break
			}
			pos += int64(w)
		}
		if err == nil {
			err = f.Sync()
		}
	}
	f.Close()
	if rerr := os.Remove(file); rerr != nil && !errors.Is(rerr, fs.ErrNotExist) {
		return rerr
	}
	return err
}

// Clear is logout: it shreds the saved token. False when there was none.
func Clear() (bool, error) {
	if _, err := os.Stat(Path()); err != nil {
		return false, nil
	}
	return true, Shred(Path())
}

// Source says where a token came from.
type Source string

const (
	FromEnv  Source = "env"
	FromFile Source = "file"
)

// ErrDamaged is returned by Resolve when the saved file exists but is unusable.
var ErrDamaged = errors.New("damaged")

// Resolve returns HIVENOD_TOKEN if set, else the saved token; "" when there is none.
func Resolve() (string, Source, error) {
	if t := os.Getenv("HIVENOD_TOKEN"); t != "" {
		return t, FromEnv, nil
	}
	s, c := Inspect()
	switch s {
	case Damaged:
		return "", "", ErrDamaged
	case OK:
		return c.Token, FromFile, nil
	}
	return "", "", nil
}
