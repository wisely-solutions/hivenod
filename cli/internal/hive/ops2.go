package hive

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// StepRef names a step.
type StepRef struct {
	StepID string `json:"stepId"`
	Name   string `json:"name"`
}

func nextState(l *loaded) map[string]any {
	next := actions.NextOnPath(l.Project, l.Item, l.Item.StepID)
	if next == nil {
		return map[string]any{"movedTo": nil, "status": "done", "waitingForPeople": false}
	}
	status := "queued"
	if next.Kind == "human" {
		status = "waiting"
	}
	return map[string]any{"movedTo": StepRef{next.ID, next.Name}, "status": status, "waitingForPeople": next.Kind == "human"}
}

const notHolding = "You do not hold this item with that run. Claim it first (hivenod work claim)."

func (c *Client) stoppedFor(ctx context.Context, runID string) error {
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return Errf(StoppedMessage(""))
	}
	return Errf(StoppedMessage(str(run.Summary)))
}

// Complete finishes the step: the item moves on along its path and stops at the next people step.
func (c *Client) Complete(ctx context.Context, itemID, runID string, o Outcome, projectID string) (map[string]any, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return nil, err
	}
	step := findStep(l.Project, l.Item.StepID)
	if step == nil || step.Kind != "agent" {
		return nil, Errf(GateMessage)
	}
	if l.Item.WorkStopped != nil && l.Item.WorkStopped.RunID == runID && l.Item.Claim == nil {
		return nil, c.stoppedFor(ctx, runID)
	}
	if l.Item.Claim == nil || l.Item.Claim.AgentUID != c.UID || l.Item.Claim.RunID != runID {
		return nil, Errf(notHolding)
	}
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	if run.EndedAt != nil {
		p, err := c.completeAfterEnd(l, run)
		if err != nil {
			return nil, err
		}
		if err := c.Write(ctx, p, l.loc()); err != nil {
			return nil, err
		}
	} else {
		r := withRunUsage(run, o, "")
		if _, err := c.writeWithStreak(ctx, func(agent *model.Agent) (plan.Plan, error) {
			rr := r
			p, err := actions.CompleteStep(c.actx(), actions.CompleteStepInput{Project: l.Project, ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item, Result: &rr, Agent: agent})
			return p, wrap(err)
		}, l.loc()); err != nil {
			return nil, err
		}
	}
	c.UntrackRun(runID)
	out := map[string]any{"itemId": itemID, "runId": runID}
	for k, v := range nextState(l) {
		out[k] = v
	}
	return out, nil
}

// completeAfterEnd moves the item alone (the run doc is closed to updates).
func (c *Client) completeAfterEnd(l *loaded, run model.Run) (plan.Plan, error) {
	cost := run.CostEur
	whole, err := actions.CompleteStep(c.actx(), actions.CompleteStepInput{Project: l.Project, ProjectID: l.ProjectID, ItemID: l.ItemID, Item: l.Item, Result: &actions.RunResult{CostEur: &cost}})
	if err != nil {
		return plan.Plan{}, wrap(err)
	}
	runPath := model.Paths.Run(c.WorkspaceID, l.Item.Claim.RunID)
	ops := make([]plan.Op, 0, len(whole.Ops))
	for _, op := range whole.Ops {
		if op.Path != runPath {
			ops = append(ops, op)
		}
	}
	whole.Ops = ops
	return whole, nil
}

// SendBackRow is one agent send-back of an item.
type SendBackRow struct {
	At         any    `json:"at"`
	By         string `json:"by"`
	FromStepID string `json:"fromStepId"`
	ToStepID   string `json:"toStepId"`
	Reason     string `json:"reason"`
}

type eventDoc struct {
	Type  string    `firestore:"type"`
	At    time.Time `firestore:"at"`
	Actor struct {
		Name string `firestore:"name"`
	} `firestore:"actor"`
	Data map[string]any `firestore:"data"`
}

func strOf(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

// agentSendBacks lists the item's item.sentBack events, oldest first.
func (c *Client) agentSendBacks(ctx context.Context, l *loaded) []SendBackRow {
	q := c.DB.Collection("workspaces/"+c.WorkspaceID+"/events").
		Where("projectId", "==", l.ProjectID).Where("itemId", "==", l.ItemID).Where("type", "==", "item.sentBack")
	snaps, err := allDocs(q.Documents(ctx))
	out := []SendBackRow{}
	if err != nil {
		return out
	}
	evs := make([]eventDoc, 0, len(snaps))
	for _, s := range snaps {
		var e eventDoc
		if s.DataTo(&e) == nil {
			evs = append(evs, e)
		}
	}
	sort.SliceStable(evs, func(i, j int) bool { return evs[i].At.Before(evs[j].At) })
	for _, e := range evs {
		out = append(out, SendBackRow{At: isoOrNull(e.At), By: e.Actor.Name, FromStepID: strOf(e.Data["fromStepId"]), ToStepID: strOf(e.Data["toStepId"]), Reason: strOf(e.Data["reason"])})
	}
	return out
}

// SendBack sends the held item back to an earlier agent step, with the reason. After
// MaxAgentSendBacks rounds without a person acting it is held for people instead.
func (c *Client) SendBack(ctx context.Context, itemID, runID, toStepID, reason string, o Outcome, projectID string) (map[string]any, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return nil, err
	}
	step := findStep(l.Project, l.Item.StepID)
	if step == nil || step.Kind != "agent" {
		return nil, Errf(GateMessage)
	}
	if l.Item.WorkStopped != nil && l.Item.WorkStopped.RunID == runID && l.Item.Claim == nil {
		return nil, c.stoppedFor(ctx, runID)
	}
	if l.Item.Claim == nil || l.Item.Claim.AgentUID != c.UID || l.Item.Claim.RunID != runID {
		return nil, Errf(notHolding)
	}
	if err := actions.RequireSendBackReason(reason); err != nil {
		return nil, wrap(err)
	}
	if _, err := actions.CheckSendBackTarget(l.Project, l.Item, toStepID); err != nil {
		return nil, wrap(err)
	}
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	if run.EndedAt != nil {
		return nil, Errf("This run has ended; claim the item again to send it back.")
	}
	to := findStep(l.Project, toStepID)
	if actions.AgentRounds(l.Item) >= model.MaxAgentSendBacks {
		var earlier []string
		for _, r := range c.agentSendBacks(ctx, l) {
			earlier = append(earlier, r.Reason)
		}
		asked, err := c.Ask(ctx, itemID, actions.StuckQuestion(earlier, jsTrim(reason)), l.ProjectID)
		if err != nil {
			return nil, err
		}
		if _, err := c.ReleaseRun(ctx, runID, "", asked.MessageID, o); err != nil {
			return nil, err
		}
		return map[string]any{"itemId": itemID, "runId": runID, "sentBack": false, "heldForPeople": true,
			"note": fmt.Sprintf(`Agents already sent this item back %d times, so it now waits for people: a question with the reasons is in "Needs you". Their answer hands it back to the agents. Your run has ended.`, model.MaxAgentSendBacks)}, nil
	}
	r := withRunUsage(run, o, "")
	var round int64
	if _, err := c.writeWithStreak(ctx, func(agent *model.Agent) (plan.Plan, error) {
		rr := r
		p, err := actions.AgentSendBack(c.actx(), actions.AgentSendBackInput{Project: l.Project, ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item, ToStepID: toStepID, Reason: reason, Result: &rr, Agent: agent})
		if err != nil {
			return plan.Plan{}, wrap(err)
		}
		round = p.Round
		return p.Plan, nil
	}, l.loc()); err != nil {
		return nil, err
	}
	c.UntrackRun(runID)
	return map[string]any{"itemId": itemID, "runId": runID, "sentBack": true, "movedTo": StepRef{to.ID, to.Name}, "round": round, "roundsLeft": model.MaxAgentSendBacks - round}, nil
}

var jsSpace = regexp.MustCompile(`^[\s\x{FEFF}\x{A0}]+|[\s\x{FEFF}\x{A0}]+$`)

func jsTrim(s string) string { return jsSpace.ReplaceAllString(s, "") }

// AddNote adds a note to the item this agent holds.
func (c *Client) AddNote(ctx context.Context, itemID, text, projectID string) (map[string]any, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return nil, err
	}
	cl := l.Item.Claim
	if cl == nil || cl.AgentUID != c.UID {
		return nil, Errf("You can add notes only to the item you are working on (claim it first).")
	}
	p, err := actions.PostMessage(c.actx(), actions.PostMessageInput{ProjectID: l.ProjectID, ItemID: itemID, Kind: "note", Text: text, RunID: sp(cl.RunID)})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, l.loc()); err != nil {
		return nil, err
	}
	return map[string]any{"messageId": p.MessageID}, nil
}

// ---------- per-item paths ----------

func (c *Client) held(ctx context.Context, itemID, runID, projectID string) (*loaded, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return nil, err
	}
	cl := l.Item.Claim
	if cl == nil || cl.AgentUID != c.UID || (runID != "" && cl.RunID != runID) {
		return nil, Errf("You do not hold this item. Path changes are for the item you are working on (claim it first).")
	}
	return l, nil
}

// Skip is one step to skip with its reason, in the order given.
type Skip struct{ StepID, Reason string }

// Shape ends a shaping run with the path.
func (c *Client) Shape(ctx context.Context, itemID, runID string, skips []Skip, note string, o Outcome, projectID string) (map[string]any, error) {
	l, err := c.held(ctx, itemID, runID, projectID)
	if err != nil {
		return nil, err
	}
	if !actions.IsUnshaped(l.Item) {
		return nil, Errf("This item is already shaped.")
	}
	m := map[string]string{}
	var order []string
	for _, s := range skips {
		if _, ok := m[s.StepID]; !ok {
			order = append(order, s.StepID)
		}
		m[s.StepID] = s.Reason
	}
	var unknown []string
	for _, id := range order {
		if findStep(l.Project, id) == nil {
			unknown = append(unknown, id)
		}
	}
	if len(unknown) > 0 {
		return nil, Errf(fmt.Sprintf("Unknown step id(s): %s. Use the ids from read_item's path.", joinStr(unknown, ", ")))
	}
	run, err := c.loadRun(ctx, runID)
	if err != nil {
		return nil, err
	}
	r := withRunUsage(run, o, "")
	build := func(agent *model.Agent) (actions.ShapeResult, error) {
		rr := r
		res, err := actions.ShapeItem(c.actx(), actions.ShapeItemInput{Where: actions.Where{Project: l.Project, ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item}, Skips: m, Note: note, Result: &rr, Agent: agent})
		return res, wrap(err)
	}
	first, err := build(nil)
	if err != nil {
		return nil, err
	}
	for _, ask := range first.Asks {
		if err := c.Write(ctx, ask.Plan, l.loc()); err != nil {
			return nil, err
		}
	}
	if _, err := c.writeWithStreak(ctx, func(agent *model.Agent) (plan.Plan, error) {
		res, err := build(agent)
		return res.Plan, err
	}, l.loc()); err != nil {
		return nil, err
	}
	c.UntrackRun(runID)
	names := func(ids []string) []string {
		out := []string{}
		for _, id := range ids {
			if s := findStep(l.Project, id); s != nil {
				out = append(out, s.Name)
			} else {
				out = append(out, id)
			}
		}
		return out
	}
	var firstStep any
	for _, s := range l.Project.Steps {
		if !contains(first.Skipped, s.ID) {
			firstStep = s.Name
			break
		}
	}
	msg := "Shaped."
	if len(first.Pending) > 0 {
		msg = "Shaped. The people steps you asked to skip stay on the path until one of their deciders approves."
	}
	return map[string]any{"itemId": itemID, "runId": runID, "skipped": names(first.Skipped), "askedToSkip": names(first.Pending), "firstStep": firstStep, "note": msg}, nil
}

func contains(xs []string, x string) bool {
	for _, e := range xs {
		if e == x {
			return true
		}
	}
	return false
}

func joinStr(xs []string, sep string) string {
	out := ""
	for i, x := range xs {
		if i > 0 {
			out += sep
		}
		out += x
	}
	return out
}

// SkipStep skips an agent step ahead on the held item, or puts it back.
func (c *Client) SkipStep(ctx context.Context, itemID, stepID string, skip bool, reason, projectID string) (map[string]any, error) {
	l, err := c.held(ctx, itemID, "", projectID)
	if err != nil {
		return nil, err
	}
	p, err := actions.SkipStep(c.actx(), actions.SkipStepInput{Where: actions.Where{Project: l.Project, ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item}, StepID: stepID, Skip: skip, Reason: reason})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.Write(ctx, p, l.loc()); err != nil {
		return nil, err
	}
	return map[string]any{"itemId": itemID, "stepId": stepID, "skipped": skip}, nil
}

// AskPathChange asks a people step's deciders to skip it (or put it back).
func (c *Client) AskPathChange(ctx context.Context, itemID, stepID, reason, projectID string) (map[string]any, error) {
	l, err := c.held(ctx, itemID, "", projectID)
	if err != nil {
		return nil, err
	}
	p, err := actions.AskPathChange(c.actx(), actions.AskPathChangeInput{Where: actions.Where{Project: l.Project, ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item}, StepID: stepID, Reason: reason})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, l.loc()); err != nil {
		return nil, err
	}
	return map[string]any{"itemId": itemID, "stepId": stepID, "op": p.Op,
		"note": `Asked: it shows under "Needs you" for the deciders of that step. Keep going meanwhile; the item waits at that step if it gets there first.`}, nil
}

// ProposeStep proposes a new library step.
func (c *Client) ProposeStep(ctx context.Context, itemID string, prop actions.ProposalInput, projectID string) (map[string]any, error) {
	l, err := c.held(ctx, itemID, "", projectID)
	if err != nil {
		return nil, err
	}
	p, err := actions.ProposeStep(c.actx(), actions.ProposeStepInput{Project: l.Project, ProjectID: l.ProjectID, ItemID: itemID, Item: l.Item, Proposal: prop})
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, l.loc()); err != nil {
		return nil, err
	}
	return map[string]any{"proposalId": p.ProposalID,
		"note": "Proposed: an approver (admins and the project creator) adds it to the library or rejects it. Carry on without it."}, nil
}
