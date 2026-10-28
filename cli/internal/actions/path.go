package actions

import (
	"slices"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Per-item paths (pathActions.ts).

// Where is the item an action changes.
type Where struct {
	Project   model.Project `json:"project"`
	ProjectID string        `json:"projectId"`
	ItemID    string        `json:"itemId"`
	Item      model.Item    `json:"item"`
}

func isDecider(project model.Project, stepID, uid string) (bool, error) {
	s, err := stepOf(project, stepID)
	if err != nil {
		return false, err
	}
	return s.Kind == "human" && s.Gate != nil && slices.Contains(s.Gate.DeciderUIDs, uid), nil
}

func rev(item model.Item) int64 { return item.PathRev + 1 }

func requireOpen(item model.Item) error {
	switch item.Status {
	case "queued", "working", "waiting":
		return nil
	}
	return fail("Only open items can change their path")
}

func requireAhead(project model.Project, item model.Item, stepID string) error {
	i, err := StepIndexOf(project, stepID)
	if err != nil {
		return err
	}
	cur, err := StepIndexOf(project, item.StepID)
	if err != nil {
		return err
	}
	if i <= cur {
		return fail(project.Steps[i].Name + " is not ahead of this item")
	}
	return nil
}

func pathNote(s string) string { return jsSlice(jsTrim(s), model.MaxPathNoteChars) }

func withSkips(item model.Item) map[string]any {
	if item.PathSkips != nil {
		return map[string]any{}
	}
	return map[string]any{"pathSkips": map[string]any{}}
}

func mapFor(step model.Step) string {
	if step.Kind == "agent" {
		return "pathSkips"
	}
	return "gateSkips"
}

func agentClaim(ctx Ctx, item model.Item) (*model.Claim, error) {
	if ctx.Actor.Type != "agent" {
		return nil, nil
	}
	c, err := OwnClaim(ctx, item)
	if err != nil {
		return nil, err
	}
	return &c, nil
}

func claimRun(c *model.Claim) *string {
	if c == nil {
		return nil
	}
	return sp(c.RunID)
}

// ShapeItemInput is shapeItem's input. Skips holds the steps to skip, with why (the library
// order decides the order, not the map).
type ShapeItemInput struct {
	Where
	Skips  map[string]string `json:"skips"`
	Note   string            `json:"note"`
	Result *RunResult        `json:"result,omitempty"`
	Agent  *model.Agent      `json:"agent,omitempty"`
}

// ShapeResult is the shaping plan, the people steps that became requests (Pending), the agent
// steps skipped at once (Skipped), and the asks to commit first, in order.
type ShapeResult struct {
	plan.Plan
	Pending []string    `json:"pending"`
	Skipped []string    `json:"skipped"`
	Asks    []AskResult `json:"asks"`
}

// ShapeItem shapes an unshaped item: agent steps in Skips are skipped at once, people steps in
// Skips become pending skip requests; the item arrives at the first step of its path.
// Commit Asks first, in order, then the returned plan.
func ShapeItem(ctx Ctx, in ShapeItemInput) (ShapeResult, error) {
	project, item := in.Project, in.Item
	if !IsUnshaped(item) {
		return ShapeResult{}, fail("This item is already shaped")
	}
	claim, err := agentClaim(ctx, item)
	if err != nil {
		return ShapeResult{}, err
	}
	if ctx.Actor.Type == "human" && item.Claim != nil {
		return ShapeResult{}, fail("An agent is shaping this item right now")
	}
	skips := map[string]string{}
	var order []string
	pending := []string{}
	for _, s := range project.Steps {
		given, ok := in.Skips[s.ID]
		if !ok {
			continue
		}
		if s.Kind == "agent" {
			if _, dup := skips[s.ID]; !dup {
				order = append(order, s.ID)
			}
			skips[s.ID] = pathNote(given)
		} else {
			pending = append(pending, s.ID)
		}
	}
	first := FirstOnPath(project, model.Item{PathSkips: skips})
	if first == nil {
		return ShapeResult{}, fail("A path needs at least one step")
	}
	by := map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID}
	asks := []AskResult{}
	state := item
	for _, id := range pending {
		given := jsTrim(in.Skips[id])
		reason := "Not needed for this item"
		if jsLen(given) >= model.MinReasonChars {
			reason = given
		}
		a, err := AskPathChange(ctx, AskPathChangeInput{Where: Where{in.Project, in.ProjectID, in.ItemID, state}, StepID: id, Reason: reason})
		if err != nil {
			return ShapeResult{}, err
		}
		asks = append(asks, a)
		reqs := make(map[string]model.PathRequest, len(state.PathRequests)+1)
		for k, v := range state.PathRequests {
			reqs[k] = v
		}
		reqs[id] = model.PathRequest{Op: "drop", By: model.ActorRef{Type: ctx.Actor.Type, ID: ctx.Actor.ID}, Reason: reason}
		state.PathRev = rev(state)
		state.PathRequests = reqs
	}
	skipped := jsKeys(order)
	skipsData := make(map[string]any, len(skips))
	for k, v := range skips {
		skipsData[k] = v
	}
	note := pathNote(in.Note)
	p := Plan(ctx, "item.shaped", Scope{sp(in.ProjectID), sp(in.ItemID), claimRun(claim)},
		map[string]any{"skipped": strs(skipped), "pending": strs(pending), "note": note, "firstStepId": first.ID},
		func(eventID string) []plan.Op {
			data := Arrival(*first)
			if claim != nil {
				cost := item.CostEur
				if in.Result != nil {
					cost += orZero(in.Result.CostEur)
				}
				data["progress"] = nil
				data["costEur"] = Num(cost)
			}
			data["shape"] = map[string]any{"by": by, "at": ServerTime(), "note": note}
			data["pathSkips"] = skipsData
			data["pathRev"] = rev(state)
			data["updatedAt"] = ServerTime()
			data["lastEventId"] = eventID
			ops := []plan.Op{{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID), Data: data}}
			if claim != nil {
				ops = append(ops, plan.Op{Kind: "update", Path: model.Paths.Run(ctx.WorkspaceID, claim.RunID), Data: RunEnd(withStatus(in.Result, "done"), eventID)})
				ops = append(ops, StreakOps(ctx, in.Agent, "done", eventID)...)
			}
			return ops
		}, "")
	return ShapeResult{Plan: p, Pending: pending, Skipped: skipped, Asks: asks}, nil
}

// SkipStepInput is skipStep's input.
type SkipStepInput struct {
	Where
	StepID string `json:"stepId"`
	Skip   bool   `json:"skip"`
	Reason string `json:"reason,omitempty"`
}

// SkipStep skips one step ahead, or puts a skipped one back. Agents: agent steps only.
func SkipStep(ctx Ctx, in SkipStepInput) (plan.Plan, error) {
	project, item, stepID := in.Project, in.Item, in.StepID
	if err := requireOpen(item); err != nil {
		return plan.Plan{}, err
	}
	if IsUnshaped(item) {
		return plan.Plan{}, fail("Shape the item first")
	}
	claim, err := agentClaim(ctx, item)
	if err != nil {
		return plan.Plan{}, err
	}
	step, err := stepOf(project, stepID)
	if err != nil {
		return plan.Plan{}, err
	}
	if err := requireAhead(project, item, stepID); err != nil {
		return plan.Plan{}, err
	}
	if step.Kind == "human" {
		dec, _ := isDecider(project, stepID, ctx.Actor.ID)
		if ctx.Actor.Type == "agent" || !dec {
			return plan.Plan{}, fail(step.Name + " is a people step: ask one of its deciders to change it")
		}
	}
	if Skips(item, step) == in.Skip {
		state := "on the path"
		if in.Skip {
			state = "skipped"
		}
		return plan.Plan{}, fail(step.Name + " is already " + state)
	}
	reason := pathNote(in.Reason)
	change := "unskip"
	var value any = DeleteField()
	if in.Skip {
		change, value = "skip", reason
	}
	return Plan(ctx, "item.pathChanged", Scope{sp(in.ProjectID), sp(in.ItemID), claimRun(claim)},
		map[string]any{"change": change, "stepId": stepID, "stepName": step.Name, "kind": step.Kind, "reason": reason},
		func(eventID string) []plan.Op {
			data := merge(withSkips(item), map[string]any{
				mapFor(step) + "." + stepID: value,
				"pathRev":                   rev(item),
				"updatedAt":                 ServerTime(),
				"lastEventId":               eventID,
			})
			return []plan.Op{{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID), Data: data}}
		}, ""), nil
}

// PathChange splits a wanted path into direct skips/unskips and asks for deciders.
type PathChange struct {
	Skip   []string `json:"skip"`
	Unskip []string `json:"unskip"`
	Ask    []string `json:"ask"`
}

// PlanPathChange splits the wanted path (step ids) into what actor may apply at once and what
// needs a decider. Only steps ahead of the current one change.
func PlanPathChange(project model.Project, item model.Item, actor model.ActorRef, wanted []string) (PathChange, error) {
	cur, err := StepIndexOf(project, item.StepID)
	if err != nil {
		return PathChange{}, err
	}
	out := PathChange{Skip: []string{}, Unskip: []string{}, Ask: []string{}}
	for i, s := range project.Steps {
		if i <= cur {
			continue
		}
		skipped := Skips(item, s)
		if slices.Contains(wanted, s.ID) == !skipped {
			continue
		}
		direct := s.Kind == "agent"
		if !direct && actor.Type == "human" {
			direct, _ = isDecider(project, s.ID, actor.ID)
		}
		switch {
		case !direct:
			out.Ask = append(out.Ask, s.ID)
		case skipped:
			out.Unskip = append(out.Unskip, s.ID)
		default:
			out.Skip = append(out.Skip, s.ID)
		}
	}
	return out, nil
}

// AskPathChangeInput is askPathChange's input.
type AskPathChangeInput struct {
	Where
	StepID string `json:"stepId"`
	Reason string `json:"reason"`
}

// AskResult is the plan and the requested op ("add" or "drop").
type AskResult struct {
	plan.Plan
	Op string `json:"op"`
}

// AskPathChange asks the deciders of a people step ahead to put it on the path or skip it.
func AskPathChange(ctx Ctx, in AskPathChangeInput) (AskResult, error) {
	project, item, stepID := in.Project, in.Item, in.StepID
	if err := requireOpen(item); err != nil {
		return AskResult{}, err
	}
	if err := RequireReason(in.Reason); err != nil {
		return AskResult{}, err
	}
	claim, err := agentClaim(ctx, item)
	if err != nil {
		return AskResult{}, err
	}
	step, err := stepOf(project, stepID)
	if err != nil {
		return AskResult{}, err
	}
	if step.Kind != "human" {
		return AskResult{}, fail(step.Name + " is an agent step: change it directly")
	}
	if err := requireAhead(project, item, stepID); err != nil {
		return AskResult{}, err
	}
	if _, ok := item.PathRequests[stepID]; ok {
		return AskResult{}, fail("A change of " + step.Name + " is pending")
	}
	if ctx.Actor.Type == "agent" && slices.Contains(item.PathRefused, stepID) {
		return AskResult{}, fail("A decider already kept " + step.Name + " as it is on this item")
	}
	op := "drop"
	if Skips(item, step) {
		op = "add"
	}
	reason := jsSlice(jsTrim(in.Reason), model.MaxPathReasonChars)
	p := Plan(ctx, "item.pathChanged", Scope{sp(in.ProjectID), sp(in.ItemID), claimRun(claim)},
		map[string]any{"change": "ask", "stepId": stepID, "stepName": step.Name, "op": op, "pending": true, "reason": reason},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID), Data: map[string]any{
				"pathRequests." + stepID: map[string]any{
					"op": op, "by": map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID}, "reason": reason, "at": ServerTime(),
				},
				"pathRev":     rev(item),
				"updatedAt":   ServerTime(),
				"lastEventId": eventID,
			}}}
		}, "")
	return AskResult{Plan: p, Op: op}, nil
}

// ProposalInput is a new library step an agent proposes.
type ProposalInput struct {
	Name         string   `json:"name"`
	Kind         string   `json:"kind"`
	Description  string   `json:"description"`
	Instructions *string  `json:"instructions,omitempty"`
	Outputs      []string `json:"outputs,omitempty"`
	// AfterStepID: the library step it goes after; "" = first.
	AfterStepID string   `json:"afterStepId"`
	DeciderUIDs []string `json:"deciderUids,omitempty"`
	Reason      string   `json:"reason"`
}

// ProposeStepInput is proposeStep's input.
type ProposeStepInput struct {
	Project   model.Project `json:"project"`
	ProjectID string        `json:"projectId"`
	ItemID    string        `json:"itemId"`
	Item      model.Item    `json:"item"`
	Proposal  ProposalInput `json:"proposal"`
	// ProposalID defaults to a new id.
	ProposalID string `json:"proposalId,omitempty"`
}

// ProposalResult is the plan and the proposal's id.
type ProposalResult struct {
	plan.Plan
	ProposalID string `json:"proposalId"`
}

// ProposeStep (agent holding the item) proposes a new library step for an approver.
func ProposeStep(ctx Ctx, in ProposeStepInput) (ProposalResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ProposalResult{}, err
	}
	claim, err := OwnClaim(ctx, in.Item)
	if err != nil {
		return ProposalResult{}, err
	}
	p := in.Proposal
	name := jsTrim(p.Name)
	if name == "" {
		return ProposalResult{}, fail("A step needs a name")
	}
	if err := RequireReason(p.Reason); err != nil {
		return ProposalResult{}, err
	}
	if p.AfterStepID != "" {
		if _, err := StepIndexOf(in.Project, p.AfterStepID); err != nil {
			return ProposalResult{}, err
		}
	}
	proposalID := in.ProposalID
	if proposalID == "" {
		proposalID = ctx.nid()
	}
	instructions := ""
	if p.Instructions != nil {
		instructions = *p.Instructions
	}
	outs := p.Outputs
	if len(outs) > 20 {
		outs = outs[:20]
	}
	outputs := make([]any, len(outs))
	for i, o := range outs {
		outputs[i] = jsSlice(o, 200)
	}
	deciders := []any{}
	if p.Kind == "human" {
		d := p.DeciderUIDs
		if len(d) > 100 {
			d = d[:100]
		}
		deciders = strs(d)
	}
	pl := Plan(ctx, "step.proposed", Scope{sp(in.ProjectID), sp(in.ItemID), sp(claim.RunID)},
		map[string]any{"proposalId": proposalID, "name": jsSlice(name, 60), "kind": p.Kind, "afterStepId": p.AfterStepID},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "set", Path: model.Paths.StepProposal(ctx.WorkspaceID, in.ProjectID, proposalID), Data: map[string]any{
				"name":         jsSlice(name, 60),
				"kind":         p.Kind,
				"description":  jsSlice(p.Description, 2000),
				"instructions": jsSlice(instructions, 20000),
				"outputs":      outputs,
				"afterStepId":  p.AfterStepID,
				"deciderUids":  deciders,
				"reason":       jsSlice(jsTrim(p.Reason), model.MaxPathReasonChars),
				"itemId":       in.ItemID,
				"by":           map[string]any{"type": "agent", "id": ctx.Actor.ID},
				"at":           ServerTime(),
				"status":       "open",
				"decision":     nil,
				"lastEventId":  eventID,
			}}}
		}, "")
	return ProposalResult{Plan: pl, ProposalID: proposalID}, nil
}
