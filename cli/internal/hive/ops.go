package hive

import (
	"context"
	"fmt"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"math"
	"sort"
	"strings"
	"time"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/attachfile"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
	"github.com/wisely-solutions/hivenod/cli/internal/store"
)

// Outcome is what a caller reports when a run ends (RunOutcome in client.ts).
type Outcome struct {
	CostEur      *float64
	TokensIn     *float64
	TokensOut    *float64
	TokensCached *float64
	// ModelSet: Model was given (possibly as null).
	ModelSet bool
	Model    *string
	Summary  *string
}

func f64(v int64) *float64 { f := float64(v); return &f }

// withRunUsage: what the caller reports, else what the run already recorded.
func withRunUsage(run model.Run, o Outcome, status string) actions.RunResult {
	r := actions.RunResult{Status: status, CostEur: o.CostEur, Summary: o.Summary}
	r.TokensIn = o.TokensIn
	if r.TokensIn == nil {
		r.TokensIn = f64(run.TokensIn)
	}
	r.TokensOut = o.TokensOut
	if r.TokensOut == nil {
		r.TokensOut = f64(run.TokensOut)
	}
	r.TokensCached = o.TokensCached
	if r.TokensCached == nil && run.TokensCached != nil {
		r.TokensCached = f64(*run.TokensCached)
	}
	if o.ModelSet {
		r.Model = o.Model
	} else {
		r.Model = run.Model
	}
	return r
}

// ---------- whoami ----------

// Who is whoami's answer.
type Who struct {
	AgentUID     string             `json:"agentUid"`
	Name         string             `json:"name"`
	WorkspaceID  string             `json:"workspaceId"`
	ProjectIDs   any                `json:"projectIds"`
	Scope        *string            `json:"scope"`
	Paused       bool               `json:"paused"`
	PausedReason *string            `json:"pausedReason"`
	Guardrails   actions.Guardrails `json:"guardrails"`
}

// PermissionsDocs is where Claude Code permissions are explained.
const PermissionsDocs = "https://docs.claude.com/en/docs/claude-code/iam"

// Text is the plain-text form.
func (w Who) Text() string {
	projects := "all"
	if s, ok := w.ProjectIDs.(string); !ok || s != "*" {
		ids := []string{}
		if l, ok := w.ProjectIDs.([]string); ok {
			ids = l
		}
		projects = strings.Join(ids, ", ")
		if projects == "" {
			projects = "none"
		}
	}
	scopeLine := "projects: " + projects
	if w.Scope != nil && *w.Scope == "inbox" {
		scopeLine = "scope: Inbox and Calendar only (no development projects)"
	}
	lines := []string{
		fmt.Sprintf("%s (%s) in organization %s", w.Name, w.AgentUID, w.WorkspaceID),
		scopeLine,
		fmt.Sprintf("guardrails: pause after %d failed runs in a row", w.Guardrails.MaxFailedRuns),
		"Permissions: your Claude Code settings (~/.claude/settings.json), see " + PermissionsDocs,
	}
	if w.Paused {
		r := ""
		if w.PausedReason != nil && *w.PausedReason != "" {
			r = ": " + *w.PausedReason
		}
		lines = append(lines, "PAUSED"+r+". An admin resumes it in Hivenod.")
	}
	return strings.Join(lines, "\n")
}

// Whoami reads the agent again and describes it.
func (c *Client) Whoami(ctx context.Context) (Who, error) {
	a, err := c.RefreshAgent(ctx)
	if err != nil {
		return Who{}, err
	}
	var ids any = "*"
	if !a.AllProjects() {
		l := a.ProjectList()
		if l == nil {
			l = []string{}
		}
		ids = l
	}
	var scope *string
	if a.Scope != "" {
		s := a.Scope
		scope = &s
	}
	return Who{AgentUID: c.UID, Name: a.Name, WorkspaceID: c.WorkspaceID, ProjectIDs: ids, Scope: scope, Paused: actions.IsPaused(a), PausedReason: a.PausedReason, Guardrails: actions.GuardrailsOf(a)}, nil
}

// ---------- work ----------

// ClaimRef of a work row.
type ClaimRef struct {
	RunID string `json:"runId"`
	Mine  bool   `json:"mine"`
	Stale bool   `json:"stale"`
}

// WorkRow is one item an agent may take now.
type WorkRow struct {
	ItemID        string          `json:"itemId"`
	ProjectID     string          `json:"projectId"`
	Project       string          `json:"project"`
	Title         string          `json:"title"`
	Type          string          `json:"type"`
	StepID        string          `json:"stepId"`
	Step          string          `json:"step"`
	Status        string          `json:"status"`
	Claim         *ClaimRef       `json:"claim"`
	Progress      *model.Progress `json:"progress"`
	SendBackCount int64           `json:"sendBackCount"`
	Job           *string         `json:"job"`
}

// Filter of list/wait.
type Filter struct {
	ProjectID string
	StepID    string
}

type itemDoc struct {
	id   string
	item model.Item
}

func (c *Client) workRows(pid string, project model.Project, docs []itemDoc, f Filter) []WorkRow {
	out := []WorkRow{}
	for _, d := range docs {
		item := d.item
		shaping := actions.IsUnshaped(item)
		var step *model.Step
		if s := findStep(project, item.StepID); s != nil && (shaping || s.Kind == "agent") {
			step = s
		}
		if step == nil || (f.StepID != "" && item.StepID != f.StepID) {
			continue
		}
		if item.AwaitingAnswer != nil || actions.IsOnHold(item) {
			continue
		}
		claim := item.Claim
		mine := claim != nil && claim.AgentUID == c.UID
		stale := claim != nil && time.Since(claim.HeartbeatAt) > 10*time.Minute
		if claim != nil && !mine && !stale {
			continue
		}
		if !mine && !shaping && !actions.AgentMayTakeStep(project, item.StepID, c.UID) {
			continue
		}
		c.mu.Lock()
		c.itemProject[d.id] = pid
		c.arrivalKeys[d.id] = arrivalKeyOf(item, d.id)
		c.mu.Unlock()
		row := WorkRow{ItemID: d.id, ProjectID: pid, Project: project.Name, Title: item.Title, Type: item.Type, StepID: item.StepID, Step: step.Name, Status: item.Status, Progress: item.Progress, SendBackCount: item.SendBackCount}
		if shaping {
			row.Step = "Shaping"
			row.Job = sp("shape")
		}
		if claim != nil {
			row.Claim = &ClaimRef{RunID: claim.RunID, Mine: mine, Stale: stale}
		}
		out = append(out, row)
	}
	return out
}

// arrivalKey is the hand-out order of work (item QjTTL, like arrivalKey in client.ts): oldest
// first by when the item reached its step (stepAt). Items without stepAt count as older than any
// that has one, among themselves by their last change; the item id breaks ties.
type arrivalKey struct {
	stepAt, updatedAt int64
	id                string
}

func arrivalKeyOf(item model.Item, id string) arrivalKey {
	k := arrivalKey{id: id}
	if item.StepAt != nil {
		k.stepAt = item.StepAt.UnixMilli()
	}
	if !item.UpdatedAt.IsZero() {
		k.updatedAt = item.UpdatedAt.UnixMilli()
	}
	return k
}

func (a arrivalKey) before(b arrivalKey) bool {
	if a.stepAt != b.stepAt {
		return a.stepAt < b.stepAt
	}
	if a.updatedAt != b.updatedAt {
		return a.updatedAt < b.updatedAt
	}
	return a.id < b.id
}

// oldestFirst sorts rows in hand-out order (item QjTTL).
func (c *Client) oldestFirst(rows []WorkRow) []WorkRow {
	c.mu.Lock()
	keys := make([]arrivalKey, len(rows))
	for i, r := range rows {
		k, ok := c.arrivalKeys[r.ItemID]
		if !ok {
			k = arrivalKey{id: r.ItemID}
		}
		keys[i] = k
	}
	c.mu.Unlock()
	idx := make([]int, len(rows))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(i, j int) bool { return keys[idx[i]].before(keys[idx[j]]) })
	out := make([]WorkRow, len(rows))
	for i, k := range idx {
		out[i] = rows[k]
	}
	return out
}

func (c *Client) workQuery(pid string) firestore.Query {
	return c.DB.Collection("workspaces/"+c.WorkspaceID+"/projects/"+pid+"/items").Where("status", "in", []any{"queued", "working"})
}

func decodeItems(snaps []*firestore.DocumentSnapshot) []itemDoc {
	out := make([]itemDoc, 0, len(snaps))
	for _, s := range snaps {
		it, err := model.DecodeItem(s)
		if err != nil {
			continue
		}
		out = append(out, itemDoc{s.Ref.ID, it})
	}
	return out
}

// ListWork lists items waiting for this agent.
func (c *Client) ListWork(ctx context.Context, f Filter) ([]WorkRow, error) {
	if _, err := c.requireNotPaused(ctx); err != nil {
		return nil, err
	}
	ids := []string{}
	if f.ProjectID == "" {
		var err error
		if ids, err = c.projectIDs(ctx); err != nil {
			return nil, err
		}
	} else {
		pid, _, err := c.ResolveProject(ctx, f.ProjectID)
		if err != nil {
			return nil, err
		}
		ids = []string{pid}
	}
	out := []WorkRow{}
	for _, pid := range ids {
		p, err := c.getProject(ctx, pid)
		if err != nil {
			return nil, err
		}
		snaps, err := allDocs(c.workQuery(pid).Documents(ctx))
		if err != nil {
			return nil, c.read(ctx, err)
		}
		out = append(out, c.workRows(pid, p, decodeItems(snaps), f)...)
	}
	return c.oldestFirst(out), nil
}

// WaitResult of WaitForWork.
type WaitResult struct {
	TimedOut bool      `json:"timedOut"`
	Work     []WorkRow `json:"work"`
}

// WaitForWork listens live until there is work for this agent (same rows as ListWork), or the
// timeout passes. exclude drops items that are not new work for the caller. Stale claims are
// re-checked every 30 s.
func (c *Client) WaitForWork(ctx context.Context, f Filter, timeout time.Duration, exclude func(string) bool) (WaitResult, error) {
	if _, err := c.requireNotPaused(ctx); err != nil {
		return WaitResult{}, err
	}
	ids := []string{}
	if f.ProjectID == "" {
		var err error
		if ids, err = c.projectIDs(ctx); err != nil {
			return WaitResult{}, err
		}
	} else {
		pid, _, err := c.ResolveProject(ctx, f.ProjectID)
		if err != nil {
			return WaitResult{}, err
		}
		ids = []string{pid}
	}
	projects := map[string]model.Project{}
	for _, pid := range ids {
		p, err := c.getProject(ctx, pid)
		if err != nil {
			return WaitResult{}, err
		}
		projects[pid] = p
	}
	wctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	type update struct {
		pid  string
		docs []itemDoc
		err  error
	}
	ch := make(chan update, len(ids))
	for _, pid := range ids {
		pid := pid
		go func() {
			listenQuery(wctx, c.recon, c.workQuery(pid), func(snaps []*firestore.DocumentSnapshot) {
				select {
				case ch <- update{pid: pid, docs: decodeItems(snaps)}:
				case <-wctx.Done():
				}
			}, func(err error) {
				select {
				case ch <- update{pid: pid, err: err}:
				case <-wctx.Done():
				}
			})
		}()
	}
	latest := map[string][]itemDoc{}
	tick := time.NewTicker(30 * time.Second)
	defer tick.Stop()
	check := func() []WorkRow {
		rows := []WorkRow{}
		for _, pid := range ids {
			if docs, ok := latest[pid]; ok {
				for _, r := range c.workRows(pid, projects[pid], docs, f) {
					if exclude == nil || !exclude(r.ItemID) {
						rows = append(rows, r)
					}
				}
			}
		}
		return c.oldestFirst(rows)
	}
	for {
		select {
		case <-wctx.Done():
			return WaitResult{TimedOut: true, Work: []WorkRow{}}, nil
		case <-tick.C:
		case u := <-ch:
			if u.err != nil {
				if Denied(u.err) {
					return WaitResult{}, Errf(c.diagnose(ctx, nil))
				}
				return WaitResult{}, u.err
			}
			latest[u.pid] = u.docs
		}
		if rows := check(); len(rows) > 0 {
			return WaitResult{Work: rows}, nil
		}
	}
}

// listenQuery delivers every snapshot of q until ctx ends. The Go client resumes broken streams
// itself; when a stream still ends with an error, or the connection comes back after a break
// (recon), it listens again at once (a full resync). Permission-denied is reported and ends it.
func listenQuery(ctx context.Context, recon *store.Reconnects, q firestore.Query, on func([]*firestore.DocumentSnapshot), onErr func(error)) {
	listenLoop(ctx, recon, func(lctx context.Context) error {
		it := q.Snapshots(lctx)
		defer it.Stop()
		for {
			snap, err := it.Next()
			if err != nil {
				return err
			}
			if docs, err := snap.Documents.GetAll(); err == nil {
				on(docs)
			}
		}
	}, onErr)
}

// listenLoop runs one listener (listen returns when its stream ends) with restarts.
func listenLoop(ctx context.Context, recon *store.Reconnects, listen func(context.Context) error, onErr func(error)) {
	backoff := time.Second
	for ctx.Err() == nil {
		var next <-chan struct{}
		if recon != nil {
			next = recon.Next()
		}
		lctx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- listen(lctx) }()
		var err error
		reconnected := false
		select {
		case err = <-done:
		case <-next:
			reconnected = true
			cancel()
			<-done
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
		if reconnected {
			backoff = time.Second
			continue
		}
		if Denied(err) {
			if onErr != nil {
				onErr(err)
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		case <-next:
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}

// ClaimOut is claim's answer.
type ClaimOut struct {
	RunID     string  `json:"runId"`
	Resumed   bool    `json:"resumed"`
	ItemID    string  `json:"itemId"`
	ProjectID string  `json:"projectId"`
	Title     string  `json:"title"`
	StepID    string  `json:"stepId"`
	Job       *string `json:"job"`
	Hint      string  `json:"hint"`
}

// Claim claims an item and starts a run; idempotent for an item this agent holds.
func (c *Client) Claim(ctx context.Context, itemID, projectID string) (ClaimOut, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return ClaimOut{}, err
	}
	step := findStep(l.Project, l.Item.StepID)
	shaping := actions.IsUnshaped(l.Item)
	if (step == nil || step.Kind != "agent") && !shaping {
		return ClaimOut{}, Errf(GateMessage)
	}
	if l.Item.AwaitingAnswer != nil {
		return ClaimOut{}, Errf(HeldMessage)
	}
	if actions.IsOnHold(l.Item) {
		return ClaimOut{}, Errf(OnHoldMessage)
	}
	if _, err := c.requireNotPaused(ctx); err != nil {
		return ClaimOut{}, err
	}
	if l.Item.Claim != nil && l.Item.Claim.AgentUID == c.UID {
		own, err := c.loadRun(ctx, l.Item.Claim.RunID)
		if err != nil {
			return ClaimOut{}, err
		}
		if own.EndedAt == nil {
			c.TrackRun(l.Item.Claim.RunID)
			return claimResult(l, l.Item.Claim.RunID, true), nil
		}
	}
	if !shaping && !actions.AgentMayTakeStep(l.Project, l.Item.StepID, c.UID) {
		return ClaimOut{}, Errf(StepLimitedMessage)
	}
	if l.Item.Status == "suggested" {
		return ClaimOut{}, Errf("This is a suggestion waiting for people to add it or dismiss it. It is not work yet.")
	}
	if l.Item.Status == "done" || l.Item.Status == "stopped" {
		return ClaimOut{}, Errf(fmt.Sprintf("This item is %s; there is nothing to claim.", l.Item.Status))
	}
	other := l.Item.Claim
	if other != nil && other.AgentUID == c.UID {
		other = nil
	}
	if other != nil && time.Since(other.HeartbeatAt) <= 10*time.Minute {
		return ClaimOut{}, Errf(TakenPrefix + " (its heartbeat is recent).")
	}
	var takeover *actions.Takeover
	if other != nil {
		if snap, err := c.DB.Doc(model.Paths.Run(c.WorkspaceID, other.RunID)).Get(ctx); err == nil && snap.Exists() {
			var old model.Run
			if snap.DataTo(&old) == nil && old.EndedAt == nil {
				takeover = &actions.Takeover{RunID: other.RunID}
			}
		}
	}
	in := actions.ClaimItemInput{ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item, Takeover: takeover}
	if shaping {
		in.Job = "shape"
	}
	p, err := actions.ClaimItem(c.actx(), in)
	if err != nil {
		return ClaimOut{}, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, l.loc()); err != nil {
		// Several agents committing on the same item at once: the server may abort the loser
		// instead of denying it. Either way this agent did not get the item.
		if status.Code(err) == codes.Aborted {
			return ClaimOut{}, Errf(TakenPrefix + " (several agents asked for it at the same moment).")
		}
		return ClaimOut{}, err
	}
	c.mu.Lock()
	c.lastBeat[p.RunID] = time.Now().UnixMilli()
	c.mu.Unlock()
	c.TrackRun(p.RunID)
	return claimResult(l, p.RunID, false), nil
}

func claimResult(l *loaded, runID string, resumed bool) ClaimOut {
	out := ClaimOut{RunID: runID, Resumed: resumed, ItemID: l.ItemID, ProjectID: l.ProjectID, Title: l.Item.Title, StepID: l.Item.StepID,
		Hint: "Call read_item for the full brief, then log, attach and complete."}
	if actions.IsUnshaped(l.Item) {
		out.Job = sp("shape")
		out.Hint = "A shaping run: read the item and the step library (read_item), then choose the steps it needs with shape_item. Do not do the work itself."
	}
	return out
}

// LogOut is log's answer.
type LogOut struct {
	RunID string `json:"runId"`
	Line  int    `json:"line"`
}

// Log appends a log line to a run.
func (c *Client) Log(ctx context.Context, runID, text, level string) (LogOut, error) {
	if level == "" {
		level = "info"
	}
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return LogOut{}, err
	}
	if run.Status == "stopped" {
		return LogOut{}, Errf(StoppedMessage(str(run.Summary)))
	}
	if run.EndedAt != nil {
		return LogOut{}, Errf("This run has ended; claim the item again with claim.")
	}
	c.mu.Lock()
	n, ok := c.nextLog[runID]
	c.mu.Unlock()
	if !ok {
		if n, err = c.countLog(ctx, runID); err != nil {
			return LogOut{}, err
		}
	}
	for attempt := 0; ; attempt++ {
		op, err := actions.LogLine(c.actx(), actions.LogLineInput{RunID: runID, N: n, Level: level, Text: text})
		if err != nil {
			return LogOut{}, wrap(err)
		}
		err = plan.Apply(ctx, c.DB, plan.Plan{Ops: []plan.Op{op}})
		if err == nil {
			break
		}
		// Another process wrote this number first: count again and retry once.
		if attempt == 0 && Denied(err) {
			if n, err = c.countLog(ctx, runID); err != nil {
				return LogOut{}, err
			}
			continue
		}
		if Denied(err) {
			return LogOut{}, Errf(c.diagnose(ctx, &loc{run.ProjectID, run.ItemID}))
		}
		return LogOut{}, err
	}
	c.mu.Lock()
	c.nextLog[runID] = n + 1
	c.mu.Unlock()
	return LogOut{RunID: runID, Line: n}, nil
}

func (c *Client) countLog(ctx context.Context, runID string) (int, error) {
	docs, err := allDocs(c.DB.Collection("workspaces/" + c.WorkspaceID + "/runs/" + runID + "/log").Documents(ctx))
	if err != nil {
		return 0, c.read(ctx, err)
	}
	return len(docs), nil
}

// BeatOut is heartbeat's answer.
type BeatOut struct {
	RunID string `json:"runId"`
	Event bool   `json:"event"`
}

func msOf(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixMilli()
}

// Heartbeat beats once (an event at most every 5 minutes; the rules coalesce the rest).
func (c *Client) Heartbeat(ctx context.Context, runID string) (BeatOut, error) {
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return BeatOut{}, err
	}
	if run.Status == "stopped" {
		return BeatOut{}, Errf(StoppedMessage(str(run.Summary)))
	}
	if run.EndedAt != nil {
		return BeatOut{}, Errf("This run has ended; nothing to keep alive.")
	}
	c.mu.Lock()
	last, ok := c.lastBeat[runID]
	c.mu.Unlock()
	if !ok {
		last = msOf(run.HeartbeatEventAt)
	}
	p, err := actions.Heartbeat(c.actx(), actions.HeartbeatInput{ProjectID: run.ProjectID, ItemID: run.ItemID, RunID: runID, LastHeartbeatEventAtMs: last})
	if err != nil {
		return BeatOut{}, wrap(err)
	}
	if err := c.Write(ctx, p, &loc{run.ProjectID, run.ItemID}); err != nil {
		return BeatOut{}, err
	}
	if p.EventID != "" {
		c.mu.Lock()
		c.lastBeat[runID] = time.Now().UnixMilli()
		c.mu.Unlock()
	}
	return BeatOut{RunID: runID, Event: p.EventID != ""}, nil
}

// TrackRun beats every HeartbeatInterval while this process lives and the run is open.
func (c *Client) TrackRun(runID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, ok := c.timers[runID]; ok {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.timers[runID] = cancel
	go func() {
		t := time.NewTicker(HeartbeatInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
			}
			bctx, bcancel := context.WithTimeout(ctx, 30*time.Second)
			_, err := c.Heartbeat(bctx, runID)
			bcancel()
			c.mu.Lock()
			if err != nil {
				c.AutoHeartbeatError = Message(err)
			} else {
				c.AutoHeartbeatError = ""
			}
			c.mu.Unlock()
			if err != nil && ctx.Err() == nil {
				c.UntrackRun(runID)
				return
			}
		}
	}()
}

// UntrackRun stops a run's heartbeats.
func (c *Client) UntrackRun(runID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if stop, ok := c.timers[runID]; ok {
		stop()
		delete(c.timers, runID)
	}
}

// AttachOut is attach's answer.
type AttachOut struct {
	AttachmentID string `json:"attachmentId"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
}

// Attach adds a deliverable (a file inlined, or a URL as a link).
func (c *Client) Attach(ctx context.Context, itemID, source, name, projectID string) (AttachOut, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return AttachOut{}, err
	}
	prep, err := attachfile.Prepare(source, name, nil)
	if err != nil {
		if attachfile.IsAttachError(err) {
			return AttachOut{}, Errf(err.Error())
		}
		return AttachOut{}, err
	}
	var runID *string
	if l.Item.Claim != nil && l.Item.Claim.AgentUID == c.UID {
		runID = sp(l.Item.Claim.RunID)
	}
	in := actions.AttachInput{ProjectID: l.ProjectID, ItemID: itemID, RunID: runID, Kind: prep.Kind, Name: prep.Name}
	if prep.HasURL {
		in.URL = sp(prep.URL)
	} else {
		in.Content = sp(prep.Content)
	}
	p, err := actions.Attach(c.actx(), in)
	if err != nil {
		return AttachOut{}, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, l.loc()); err != nil {
		return AttachOut{}, err
	}
	return AttachOut{AttachmentID: p.AttachmentID, Name: prep.Name, Kind: prep.Kind}, nil
}

// AskOut is ask's answer.
type AskOut struct {
	MessageID string `json:"messageId"`
	Note      string `json:"note"`
}

// Ask posts a question on an item this agent holds ("Needs you").
func (c *Client) Ask(ctx context.Context, itemID, text, projectID string) (AskOut, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return AskOut{}, err
	}
	claim := l.Item.Claim
	if claim == nil {
		return AskOut{}, Errf(fmt.Sprintf("You have not claimed this item, so you cannot ask a question on it yet. Call claim with itemId %s first.", itemID))
	}
	if claim.AgentUID != c.UID {
		return AskOut{}, Errf("Another agent holds this item right now.")
	}
	p, err := actions.PostMessage(c.actx(), actions.PostMessageInput{ProjectID: l.ProjectID, ItemID: itemID, Kind: "question", Text: text, RunID: sp(claim.RunID)})
	if err != nil {
		return AskOut{}, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, l.loc()); err != nil {
		return AskOut{}, err
	}
	return AskOut{MessageID: p.MessageID, Note: `The question now shows under "Needs you" in Hivenod.`}, nil
}

// ProgressOut is progress's answer.
type ProgressOut struct {
	ItemID   string         `json:"itemId"`
	Progress model.Progress `json:"progress"`
}

// Progress reports done out of total.
func (c *Client) Progress(ctx context.Context, itemID string, done, total float64, projectID string) (ProgressOut, error) {
	if done != math.Trunc(done) || total != math.Trunc(total) || done < 0 || total < done {
		return ProgressOut{}, Errf("Progress needs whole numbers with 0 <= done <= total.")
	}
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return ProgressOut{}, err
	}
	p, err := actions.ReportProgress(c.actx(), actions.ReportProgressInput{ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item, Progress: actions.Given(actions.ProgressInput{Done: done, Total: total})})
	if err != nil {
		return ProgressOut{}, wrap(err)
	}
	if err := c.Write(ctx, p, l.loc()); err != nil {
		return ProgressOut{}, err
	}
	return ProgressOut{ItemID: itemID, Progress: model.Progress{Done: int64(done), Total: int64(total)}}, nil
}

// FindingOut is raise_finding's answer.
type FindingOut struct {
	FindingItemID string `json:"findingItemId"`
	Status        string `json:"status"`
	Note          string `json:"note"`
}

// RaiseFinding suggests something outside the task to people.
func (c *Client) RaiseFinding(ctx context.Context, itemID, title, details, projectID string) (FindingOut, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return FindingOut{}, err
	}
	p, err := actions.RaiseFinding(c.actx(), actions.RaiseFindingInput{Project: l.Project, ProjectID: l.ProjectID, ParentItemID: itemID, Parent: l.Item, Title: title, Details: details})
	if err != nil {
		return FindingOut{}, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, l.loc()); err != nil {
		return FindingOut{}, err
	}
	first := "the first step"
	if len(l.Project.Steps) > 0 {
		first = l.Project.Steps[0].Name
	}
	return FindingOut{FindingItemID: p.ItemID, Status: "suggested",
		Note: fmt.Sprintf("Suggested to people: it waits in the %s suggestions until someone adds it or dismisses it. It is not work: it never shows in work list and cannot be claimed.", first)}, nil
}

// writeWithStreak writes a plan that ends a run together with the failure streak; returns the
// pause message when this write paused the agent. A refused streak write is retried once with
// the agent read again, then written without the streak (the run's end is never lost).
func (c *Client) writeWithStreak(ctx context.Context, build func(agent *model.Agent) (plan.Plan, error), at *loc) (string, error) {
	for attempt := 0; attempt < 2; attempt++ {
		agent, err := c.RefreshAgent(ctx)
		if err != nil {
			return "", err
		}
		p, err := build(&agent)
		if err != nil {
			return "", err
		}
		err = plan.Apply(ctx, c.DB, p)
		if err == nil {
			me := model.Paths.Agent(c.WorkspaceID, c.UID)
			for _, op := range p.Ops {
				if op.Path == me {
					if _, ok := op.Data["pausedAt"]; ok {
						return pausedNow(agent), nil
					}
				}
			}
			return "", nil
		}
		if !Denied(err) {
			return "", err
		}
	}
	p, err := build(nil)
	if err != nil {
		return "", err
	}
	return "", c.Write(ctx, p, at)
}

// EndRun ends a run without moving the item; a failed run gives the item back.
func (c *Client) EndRun(ctx context.Context, runID, status string, o Outcome) (map[string]any, error) {
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	if run.Status == "stopped" {
		return nil, Errf(StoppedMessage(str(run.Summary)))
	}
	if run.EndedAt != nil {
		return nil, Errf("This run has already ended.")
	}
	result := withRunUsage(run, o, status)
	var l *loaded
	if status == "failed" {
		if l, err = c.load(ctx, run.ItemID, run.ProjectID); err != nil {
			return nil, err
		}
	}
	held := l != nil && l.Item.Claim != nil && l.Item.Claim.AgentUID == c.UID && l.Item.Claim.RunID == runID
	paused, err := c.writeWithStreak(ctx, func(agent *model.Agent) (plan.Plan, error) {
		if held {
			r := result
			p, err := actions.ReleaseClaim(c.actx(), actions.ReleaseClaimInput{ProjectID: l.ProjectID, ItemID: run.ItemID, Item: l.Item, Result: &r, Status: "failed", Agent: agent})
			return p, wrap(err)
		}
		p, err := actions.EndRun(c.actx(), actions.EndRunInput{ProjectID: run.ProjectID, ItemID: run.ItemID, RunID: runID, Result: result, Agent: agent})
		return p, wrap(err)
	}, &loc{run.ProjectID, run.ItemID})
	if err != nil {
		return nil, err
	}
	c.UntrackRun(runID)
	out := map[string]any{"runId": runID, "status": status}
	if result.CostEur != nil {
		out["costEur"] = *result.CostEur
	}
	if result.TokensIn != nil {
		out["tokensIn"] = *result.TokensIn
	}
	if result.TokensOut != nil {
		out["tokensOut"] = *result.TokensOut
	}
	if result.TokensCached != nil {
		out["tokensCached"] = *result.TokensCached
	}
	out["model"] = result.Model
	if result.Summary != nil {
		out["summary"] = *result.Summary
	}
	if held {
		out["released"] = true
	}
	if paused != "" {
		out["agentPaused"] = true
		out["note"] = paused
	}
	return out, nil
}

// Release gives an item this agent holds back to the queue.
func (c *Client) Release(ctx context.Context, itemID, projectID string) (map[string]any, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return nil, err
	}
	cl := l.Item.Claim
	if cl == nil || cl.AgentUID != c.UID {
		return nil, Errf("You do not hold this item, so there is nothing to release.")
	}
	run, err := c.loadRun(ctx, cl.RunID)
	if err != nil {
		return nil, err
	}
	r := withRunUsage(run, Outcome{}, "")
	p, err := actions.ReleaseClaim(c.actx(), actions.ReleaseClaimInput{ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item, Result: &r, RunEnded: run.EndedAt != nil})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.Write(ctx, p, l.loc()); err != nil {
		return nil, err
	}
	c.UntrackRun(cl.RunID)
	return map[string]any{"itemId": itemID, "runId": cl.RunID, "released": true}, nil
}

// Usage is report_usage's input (running totals).
type Usage struct {
	TokensIn     float64
	TokensOut    float64
	TokensCached *float64
	ModelSet     bool
	Model        *string
	CostEur      *float64
}

// ReportUsage reports the run's token usage so far.
func (c *Client) ReportUsage(ctx context.Context, runID string, u Usage) (map[string]any, error) {
	cached := 0.0
	if u.TokensCached != nil {
		cached = *u.TokensCached
	}
	for _, kv := range []struct {
		k string
		v float64
	}{{"tokensIn", u.TokensIn}, {"tokensOut", u.TokensOut}, {"tokensCached", cached}} {
		if kv.v != math.Trunc(kv.v) || kv.v < 0 {
			return nil, Errf(kv.k + " must be a whole number >= 0.")
		}
	}
	if cached > u.TokensIn {
		return nil, Errf("tokensCached is part of tokensIn, so it cannot be larger.")
	}
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	if run.Status == "stopped" {
		return nil, Errf(StoppedMessage(str(run.Summary)))
	}
	if run.EndedAt != nil {
		return nil, Errf("This run has ended; claim the item again with claim.")
	}
	var runCached int64
	if run.TokensCached != nil {
		runCached = *run.TokensCached
	}
	given := float64(runCached)
	if u.TokensCached != nil {
		given = *u.TokensCached
	}
	if u.TokensIn < float64(run.TokensIn) || u.TokensOut < float64(run.TokensOut) || given < float64(runCached) {
		return nil, Errf(fmt.Sprintf("Report running totals for the whole run; they only grow (so far: %d in, %d out).", run.TokensIn, run.TokensOut))
	}
	c.mu.Lock()
	last, ok := c.lastBeat[runID]
	c.mu.Unlock()
	if !ok {
		last = msOf(run.HeartbeatEventAt)
	}
	ru := &actions.RunUsage{TokensIn: u.TokensIn, TokensOut: u.TokensOut, TokensCached: u.TokensCached}
	if u.ModelSet {
		if u.Model == nil {
			ru.Model = actions.Null[string]()
		} else {
			ru.Model = actions.Given(*u.Model)
		}
	}
	if u.CostEur != nil {
		v := math.Max(*u.CostEur, run.CostEur)
		ru.CostEur = &v
	}
	p, err := actions.Heartbeat(c.actx(), actions.HeartbeatInput{ProjectID: run.ProjectID, ItemID: run.ItemID, RunID: runID, LastHeartbeatEventAtMs: last, Usage: ru})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.Write(ctx, p, &loc{run.ProjectID, run.ItemID}); err != nil {
		return nil, err
	}
	if p.EventID != "" {
		c.mu.Lock()
		c.lastBeat[runID] = time.Now().UnixMilli()
		c.mu.Unlock()
	}
	return map[string]any{"runId": runID, "newTokens": actions.NewTokens(actions.TokenUsage{TokensIn: u.TokensIn, TokensOut: u.TokensOut, TokensCached: u.TokensCached})}, nil
}

// ReleaseResult of ReleaseRun.
type ReleaseResult struct {
	Status      string
	Held        bool
	AgentPaused string
}

// ReleaseRun gives the item back without moving it: the run ends as released (or failed). With
// holdFor (a question this agent asked on the item) nobody can claim it until people answer.
func (c *Client) ReleaseRun(ctx context.Context, runID, status, holdFor string, o Outcome) (ReleaseResult, error) {
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return ReleaseResult{}, err
	}
	if run.Status == "stopped" {
		return ReleaseResult{}, Errf(StoppedMessage(str(run.Summary)))
	}
	if run.EndedAt != nil {
		return ReleaseResult{}, Errf("This run has already ended.")
	}
	if status == "" {
		status = "released"
	}
	l, err := c.load(ctx, run.ItemID, run.ProjectID)
	if err != nil {
		return ReleaseResult{}, err
	}
	result := withRunUsage(run, o, "")
	held := false
	var paused string
	if l.Item.Claim != nil && l.Item.Claim.AgentUID == c.UID && l.Item.Claim.RunID == runID {
		held = holdFor != ""
		paused, err = c.writeWithStreak(ctx, func(agent *model.Agent) (plan.Plan, error) {
			r := result
			p, err := actions.ReleaseClaim(c.actx(), actions.ReleaseClaimInput{ProjectID: l.ProjectID, ItemID: run.ItemID, Item: l.Item, Result: &r, Status: status, Agent: agent, HoldFor: holdFor})
			return p, wrap(err)
		}, l.loc())
	} else {
		paused, err = c.writeWithStreak(ctx, func(agent *model.Agent) (plan.Plan, error) {
			r := result
			r.Status = "failed"
			p, err := actions.EndRun(c.actx(), actions.EndRunInput{ProjectID: run.ProjectID, ItemID: run.ItemID, RunID: runID, Result: r, Agent: agent})
			return p, wrap(err)
		}, &loc{run.ProjectID, run.ItemID})
	}
	if err != nil {
		return ReleaseResult{}, err
	}
	c.UntrackRun(runID)
	return ReleaseResult{Status: status, Held: held, AgentPaused: paused}, nil
}
