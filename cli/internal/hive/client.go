package hive

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/auth"
	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/pairing"
	"github.com/wisely-solutions/hivenod/cli/internal/store"
	"github.com/wisely-solutions/hivenod/cli/internal/token"
	"github.com/wisely-solutions/hivenod/cli/internal/update"
)

// Client is a signed-in agent (HiveClient in client.ts).
type Client struct {
	WorkspaceID string
	UID         string
	DB          *firestore.Client
	sess        *auth.Session
	ctx         actions.Ctx
	recon       *store.Reconnects

	mu          sync.Mutex
	agent       model.Agent
	clockOffset time.Duration
	// WebURL is the Hivenod site (https://hivenod.com), for links to items.
	WebURL string
	// The channel session's presence identity (presence.go, item N0biX); "" outside one.
	sessionID, hostID string
}

// Connect signs in with the token (tok "" = HIVENOD_TOKEN, then the saved pairing) and reads
// the agent's own doc: a revoked or missing agent is refused with a plain message.
func Connect(ctx context.Context, cfg Config, tok string) (*Client, error) {
	if tok == "" {
		t, _, err := credentials.Resolve()
		if errors.Is(err, credentials.ErrDamaged) {
			return nil, Errf(credentials.DamagedMessage())
		}
		tok = t
	}
	if tok == "" {
		return nil, Errf(NotPairedMessage)
	}
	parts, err := token.Decode(tok)
	if err != nil {
		return nil, Errf(BadTokenMessage)
	}
	sess, err := auth.SignIn(ctx, auth.Config{APIKey: cfg.APIKey, Emulator: cfg.AuthEmulator}, parts.Email, parts.Password)
	if err != nil {
		if RateLimited(err) {
			return nil, Errf(RateLimitMessage)
		}
		var ae *auth.Error
		if errors.As(err, &ae) {
			return nil, Errf(RejectedMessage)
		}
		return nil, err
	}
	db, recon, err := store.OpenWatched(ctx, cfg.storeConfig(), sess)
	if err != nil {
		return nil, err
	}
	c := &Client{
		recon:       recon,
		WorkspaceID: parts.Workspace,
		UID:         sess.UID(),
		DB:          db,
		sess:        sess,
		WebURL:      strings.TrimRight(cfg.WebURL, "/"),
	}
	a, err := c.readAgent(ctx)
	if err != nil {
		db.Close()
		if Denied(err) || NotFound(err) {
			return nil, Errf(RevokedMessage)
		}
		return nil, err
	}
	if a.RevokedAt != nil {
		db.Close()
		return nil, Errf(RevokedMessage)
	}
	c.agent = a
	c.ctx = actions.Ctx{WorkspaceID: parts.Workspace, Actor: actions.Actor{Type: "agent", ID: c.UID, Name: a.Name}}
	return c, nil
}

// Close stops the connection.
func (c *Client) Close() {
	c.DB.Close()
}

func (c *Client) actx() actions.Ctx {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ctx
}

// Agent is the last read agent doc.
func (c *Client) Agent() model.Agent {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.agent
}

func (c *Client) readAgent(ctx context.Context) (model.Agent, error) {
	snap, err := c.DB.Doc(model.Paths.Agent(c.WorkspaceID, c.UID)).Get(ctx)
	if err != nil {
		return model.Agent{}, err
	}
	var a model.Agent
	if err := snap.DataTo(&a); err != nil {
		return model.Agent{}, err
	}
	return a, nil
}

// RefreshAgent reads this agent's doc again (settings, pause).
func (c *Client) RefreshAgent(ctx context.Context) (model.Agent, error) {
	a, err := c.readAgent(ctx)
	if err != nil {
		if Denied(err) || NotFound(err) {
			return model.Agent{}, Errf(RevokedMessage)
		}
		return model.Agent{}, err
	}
	if a.RevokedAt != nil {
		return model.Agent{}, Errf(RevokedMessage)
	}
	c.mu.Lock()
	c.agent = a
	c.ctx.Actor.Name = a.Name
	c.mu.Unlock()
	return a, nil
}

// ---------- reading ----------

// wrap turns action errors into client errors (the same message).
func wrap(err error) error {
	var ae *actions.Error
	if errors.As(err, &ae) {
		return Errf(ae.Msg)
	}
	return err
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func str(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func sp(s string) *string { return &s }

// ---------- small things ----------

// MarkSeen tells Hivenod this agent is online (shown for 2 minutes).
func (c *Client) MarkSeen(ctx context.Context) error {
	host, _ := os.Hostname()
	ups := []firestore.Update{
		{Path: "lastSeenAt", Value: firestore.ServerTimestamp},
		{Path: "seenHost", Value: clipRunes(host, 80)},
	}
	ups = append(ups, c.presenceFields()...)
	// The CLI's own version, so the web app can tell when it is too old for an event (item N9EEn).
	// A development build (no version stamped) writes none.
	if v := update.Version; v != "" && v != "0.0.0" {
		ups = append(ups, firestore.Update{Path: "cliVersion", Value: clipRunes(v, 40)})
	}
	_, err := c.DB.Doc(model.Paths.Agent(c.WorkspaceID, c.UID)).Update(ctx, ups)
	return err
}

// MarkOffline tells Hivenod this agent stopped (shown offline at once).
func (c *Client) MarkOffline(ctx context.Context) error {
	_, err := c.DB.Doc(model.Paths.Agent(c.WorkspaceID, c.UID)).Update(ctx, []firestore.Update{
		{Path: "signedOutAt", Value: firestore.ServerTimestamp},
	})
	return err
}

// DeletePairing removes the pairing request this terminal was paired with.
func (c *Client) DeletePairing(ctx context.Context, code string) {
	_, _ = c.DB.Doc(pairing.Path(code)).Delete(ctx)
}

func clipRunes(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		return string(r[:n])
	}
	return s
}

// JSON renders a result like JSON.stringify(v, null, 2).
func JSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
	return strings.TrimRight(buf.String(), "\n")
}

// iso is new Date(ms).toISOString().
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func isoPtr(t *time.Time) any {
	if t == nil || t.IsZero() {
		return nil
	}
	return iso(*t)
}
