package hive

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/user"
	"strconv"
	"strings"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
)

// Presence identity of a channel session (item N0biX): a random session id, and a stable id of
// the machine and the OS user it runs as. A restarted session on the same machine finds the old
// session's presence with the same host id and takes over at once; another machine is refused.

// HostID is a stable, anonymous id of this machine and OS user: a hash of the machine id (or the
// host name) and the user. HIVENOD_HOST_ID replaces it (tests simulate a second machine with it).
func HostID() string {
	if v := strings.TrimSpace(os.Getenv("HIVENOD_HOST_ID")); v != "" {
		return clipRunes(v, 64)
	}
	machine := ""
	for _, f := range []string{"/etc/machine-id", "/var/lib/dbus/machine-id"} {
		if b, err := os.ReadFile(f); err == nil {
			if m := strings.TrimSpace(string(b)); m != "" {
				machine = m
				break
			}
		}
	}
	if machine == "" {
		machine, _ = os.Hostname()
	}
	who := strconv.Itoa(os.Getuid())
	if u, err := user.Current(); err == nil && u.Username != "" {
		who = u.Username
	}
	sum := sha256.Sum256([]byte("hivenod-host\x00" + machine + "\x00" + who))
	return hex.EncodeToString(sum[:16])
}

// NewSessionID is a random id for one channel session.
func NewSessionID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// presenceFields are the session's own presence fields (none outside a channel session).
func (c *Client) presenceFields() []firestore.Update {
	c.mu.Lock()
	sid, hid := c.sessionID, c.hostID
	c.mu.Unlock()
	if sid == "" {
		return nil
	}
	return []firestore.Update{{Path: "seenSession", Value: sid}, {Path: "seenHostId", Value: hid}}
}

// SetPresenceIdentity makes MarkSeen stamp this session and host id.
func (c *Client) SetPresenceIdentity(sessionID, hostID string) {
	c.mu.Lock()
	c.sessionID, c.hostID = sessionID, hostID
	c.mu.Unlock()
}

// PresenceIdentity is the session and host id MarkSeen stamps.
func (c *Client) PresenceIdentity() (sessionID, hostID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sessionID, c.hostID
}

// StartDecision reads the agent's presence and says what this session does: free, takeover or busy.
func (c *Client) StartDecision() (string, *actions.Terminal) {
	sid, hid := c.PresenceIdentity()
	a := c.Agent()
	now := c.ServerNow().UnixMilli()
	return actions.StartDecision(a, now, hid, sid), actions.LiveTerminal(a, now)
}

// TakenOver reads the agent doc again: true when another live session replaced this one's presence.
func (c *Client) TakenOver(ctx context.Context) (bool, error) {
	a, err := c.RefreshAgent(ctx)
	if err != nil {
		return false, err
	}
	sid, _ := c.PresenceIdentity()
	return actions.TakenOver(a, c.ServerNow().UnixMilli(), sid), nil
}

