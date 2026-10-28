package hive

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/auth"
	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/pairing"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
	"github.com/wisely-solutions/hivenod/cli/internal/store"
	"github.com/wisely-solutions/hivenod/cli/internal/token"
)

// HeartbeatInterval: how often an open run beats while this process lives.
var HeartbeatInterval = 60 * time.Second

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
	timers      map[string]context.CancelFunc
	lastBeat    map[string]int64
	nextLog     map[string]int
	itemProject map[string]string
	arrivalKeys map[string]arrivalKey // the hand-out order key of each work row seen
	// AutoHeartbeatError is the last problem an automatic heartbeat hit.
	AutoHeartbeatError string
	clockOffset        time.Duration
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
		timers:      map[string]context.CancelFunc{},
		lastBeat:    map[string]int64{},
		nextLog:     map[string]int{},
		itemProject: map[string]string{},
		arrivalKeys: map[string]arrivalKey{},
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

// Close stops the heartbeats and the connection.
func (c *Client) Close() {
	c.mu.Lock()
	for _, stop := range c.timers {
		stop()
	}
	c.timers = map[string]context.CancelFunc{}
	c.mu.Unlock()
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

func pausedMessage(a model.Agent) string {
	r := ""
	if a.PausedReason != nil && *a.PausedReason != "" {
		r = " (" + *a.PausedReason + ")"
	}
	return "This agent is paused" + r + ". It takes no new work until an admin resumes it on its page in Hivenod (Agents)."
}

func pausedNow(a model.Agent) string {
	return fmt.Sprintf("This agent is now paused after %d failed runs in a row (limit %d). It takes no new work until an admin resumes it in Hivenod.", a.FailStreak+1, actions.GuardrailsOf(a).MaxFailedRuns)
}

func (c *Client) requireNotPaused(ctx context.Context) (model.Agent, error) {
	a, err := c.RefreshAgent(ctx)
	if err != nil {
		return a, err
	}
	if actions.IsPaused(a) {
		return a, Errf(pausedMessage(a))
	}
	return a, nil
}

// ---------- reading ----------

// read turns a permission error into a message a person can act on.
func (c *Client) read(ctx context.Context, err error) error {
	if err != nil && Denied(err) {
		return Errf(c.diagnose(ctx, nil))
	}
	return err
}

func (c *Client) getProject(ctx context.Context, pid string) (model.Project, error) {
	snap, err := c.DB.Doc(model.Paths.Project(c.WorkspaceID, pid)).Get(ctx)
	if err != nil && !NotFound(err) {
		return model.Project{}, c.read(ctx, err)
	}
	if err != nil || !snap.Exists() {
		return model.Project{}, Errf(fmt.Sprintf("Project %s not found, or this agent may not use it", pid))
	}
	var p model.Project
	if err := snap.DataTo(&p); err != nil {
		return model.Project{}, err
	}
	return p, nil
}

func (c *Client) projectIDs(ctx context.Context) ([]string, error) {
	a := c.Agent()
	if !a.AllProjects() {
		return a.ProjectList(), nil
	}
	docs, err := c.DB.Collection("workspaces/" + c.WorkspaceID + "/projects").Documents(ctx).GetAll()
	if err != nil {
		return nil, c.read(ctx, err)
	}
	out := make([]string, len(docs))
	for i, d := range docs {
		out[i] = d.Ref.ID
	}
	return out, nil
}

type loaded struct {
	ProjectID string
	ItemID    string
	Project   model.Project
	Item      model.Item
}

func (l *loaded) loc() *loc { return &loc{l.ProjectID, l.ItemID} }

type loc struct{ ProjectID, ItemID string }

// load finds an item by id in the projects this agent may use.
func (c *Client) load(ctx context.Context, itemID, projectID string) (*loaded, error) {
	var cands []string
	if projectID != "" {
		cands = []string{projectID}
	} else {
		c.mu.Lock()
		if p, ok := c.itemProject[itemID]; ok {
			cands = append(cands, p)
		}
		c.mu.Unlock()
		ids, err := c.projectIDs(ctx)
		if err != nil {
			return nil, err
		}
		cands = append(cands, ids...)
	}
	seen := map[string]bool{}
	for _, pid := range cands {
		if seen[pid] {
			continue
		}
		seen[pid] = true
		snap, err := c.DB.Doc(model.Paths.Item(c.WorkspaceID, pid, itemID)).Get(ctx)
		if err != nil {
			if NotFound(err) {
				continue
			}
			if e := c.read(ctx, err); e != nil {
				var he *Error
				if errors.As(e, &he) {
					continue
				}
				return nil, e
			}
		}
		if !snap.Exists() {
			continue
		}
		it, err := model.DecodeItem(snap)
		if err != nil {
			return nil, err
		}
		c.mu.Lock()
		c.itemProject[itemID] = pid
		c.mu.Unlock()
		p, err := c.getProject(ctx, pid)
		if err != nil {
			return nil, err
		}
		return &loaded{ProjectID: pid, ItemID: itemID, Project: p, Item: it}, nil
	}
	return nil, Errf(fmt.Sprintf("Item %s not found. Check the id (hivenod work list) and that this agent may use its project.", itemID))
}

func (c *Client) loadRun(ctx context.Context, runID string) (model.Run, error) {
	snap, err := c.DB.Doc(model.Paths.Run(c.WorkspaceID, runID)).Get(ctx)
	if err != nil && !NotFound(err) {
		return model.Run{}, c.read(ctx, err)
	}
	var r model.Run
	if err == nil && snap.Exists() {
		if err := snap.DataTo(&r); err != nil {
			return model.Run{}, err
		}
	}
	if err != nil || !snap.Exists() || r.AgentUID != c.UID {
		return model.Run{}, Errf(fmt.Sprintf("Run %s not found (it must be one of your own)", runID))
	}
	return r, nil
}

// ---------- writing ----------

// Write commits one plan. A denied write is explained (gate, someone else's claim, revoked, …).
func (c *Client) Write(ctx context.Context, p plan.Plan, at *loc) error {
	if err := plan.Apply(ctx, c.DB, p); err != nil {
		if Denied(err) {
			return Errf(c.diagnose(ctx, at))
		}
		return err
	}
	return nil
}

func (c *Client) diagnose(ctx context.Context, at *loc) string {
	snap, err := c.DB.Doc(model.Paths.Agent(c.WorkspaceID, c.UID)).Get(ctx)
	if err != nil || !snap.Exists() {
		return RevokedMessage
	}
	var me model.Agent
	_ = snap.DataTo(&me)
	if me.RevokedAt != nil {
		return RevokedMessage
	}
	if me.PausedAt != nil {
		return pausedMessage(me)
	}
	if at != nil {
		if l, err := c.load(ctx, at.ItemID, at.ProjectID); err == nil {
			step := findStep(l.Project, l.Item.StepID)
			if step != nil && step.Kind == "human" && !actions.IsUnshaped(l.Item) {
				return GateMessage
			}
			if l.Item.AwaitingAnswer != nil {
				return HeldMessage
			}
			if l.Item.WorkStopped != nil && l.Item.Claim == nil {
				run, err := c.loadRun(ctx, l.Item.WorkStopped.RunID)
				if err == nil && run.Status == "stopped" {
					return StoppedMessage(str(run.Summary))
				}
				return OnHoldMessage
			}
			if l.Item.Claim == nil && !actions.AgentMayTakeStep(l.Project, l.Item.StepID, c.UID) {
				return StepLimitedMessage
			}
			if l.Item.Claim != nil && l.Item.Claim.AgentUID != c.UID {
				return "Another agent holds this item right now."
			}
		}
	}
	return "Hivenod refused this change (permission denied). This agent may not be allowed on this project, or the item is no longer in the state it was read in. Read the item again with hivenod item read."
}

// wrap turns action errors into client errors (the same message).
func wrap(err error) error {
	var ae *actions.Error
	if errors.As(err, &ae) {
		return Errf(ae.Msg)
	}
	return err
}

func findStep(p model.Project, id string) *model.Step {
	for i := range p.Steps {
		if p.Steps[i].ID == id {
			return &p.Steps[i]
		}
	}
	return nil
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
	_, err := c.DB.Doc(model.Paths.Agent(c.WorkspaceID, c.UID)).Update(ctx, []firestore.Update{
		{Path: "lastSeenAt", Value: firestore.ServerTimestamp},
		{Path: "seenHost", Value: clipRunes(host, 80)},
	})
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

func isoOrNull(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return iso(t)
}

func sortByAt[T any](xs []T, at func(T) time.Time) {
	sort.SliceStable(xs, func(i, j int) bool { return at(xs[i]).Before(at(xs[j])) })
}

func allDocs(it *firestore.DocumentIterator) ([]*firestore.DocumentSnapshot, error) {
	var out []*firestore.DocumentSnapshot
	for {
		d, err := it.Next()
		if errors.Is(err, iterator.Done) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
}
