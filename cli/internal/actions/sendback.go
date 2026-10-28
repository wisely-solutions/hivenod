package actions

import (
	"strconv"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Agent send-back (sendback.ts).

// MaxAgentSendBacks: rounds before the item is held for people.
const MaxAgentSendBacks = model.MaxAgentSendBacks

// StuckQuestionPrefix starts the question an agent asks when the round limit is reached.
var StuckQuestionPrefix = "Agents sent this back " + strconv.Itoa(MaxAgentSendBacks) + " times"

// AgentRounds is the agent send-backs so far on this item.
func AgentRounds(item model.Item) int64 { return item.AgentSendBacks }

// AgentSendBackTargets is the earlier agent steps on the path the item may go back to, nearest
// first, never across a people step and at most MaxSendBackSpan steps in between.
func AgentSendBackTargets(project model.Project, item model.Item) []model.Step {
	at := -1
	for i, s := range project.Steps {
		if s.ID == item.StepID {
			at = i
			break
		}
	}
	out := []model.Step{}
	for i := at - 1; i >= 0 && at-i-1 <= model.MaxSendBackSpan; i-- {
		s := project.Steps[i]
		if Skips(item, s) {
			continue
		}
		if s.Kind == "human" {
			break
		}
		out = append(out, s)
	}
	return out
}

// CheckSendBackTarget returns the target step, or an error saying why it is not valid.
func CheckSendBackTarget(project model.Project, item model.Item, toStepID string) (model.Step, error) {
	to, err := stepOf(project, toStepID)
	if err != nil {
		return model.Step{}, err
	}
	if to.ID == item.StepID {
		return model.Step{}, fail("That is the step the item is at now")
	}
	for _, s := range AgentSendBackTargets(project, item) {
		if s.ID == to.ID {
			return to, nil
		}
	}
	from, err := StepIndexOf(project, item.StepID)
	if err != nil {
		return model.Step{}, err
	}
	toIdx, _ := StepIndexOf(project, to.ID)
	if toIdx > from {
		return model.Step{}, fail("You can only send an item back to an earlier step")
	}
	if Skips(item, to) {
		return model.Step{}, fail(to.Name + " is not on this item's path (it is skipped)")
	}
	if to.Kind == "human" {
		return model.Step{}, fail(to.Name + " is a people step: agents send back to agent steps only")
	}
	if from-toIdx-1 > model.MaxSendBackSpan {
		return model.Step{}, fail(to.Name + " is too far back (more than " + strconv.Itoa(model.MaxSendBackSpan) +
			" steps in between): send it to a nearer step, or ask people")
	}
	return model.Step{}, fail(to.Name + " is before a people step on this item's path: agents never send an item back across people")
}

// RequireSendBackReason wants a reason, not too long.
func RequireSendBackReason(reason string) error {
	if jsTrim(reason) == "" {
		return fail("Say why you send it back (a reason is required)")
	}
	if jsLen(reason) > model.MaxSendBackReasonChars {
		return fail("Keep the reason under " + strconv.Itoa(model.MaxSendBackReasonChars) + " characters")
	}
	return nil
}

// AgentSendBackInput is agentSendBack's input.
type AgentSendBackInput struct {
	Project   model.Project `json:"project"`
	ProjectID string        `json:"projectId"`
	ItemID    string        `json:"itemId"`
	Item      model.Item    `json:"item"`
	ToStepID  string        `json:"toStepId"`
	Reason    string        `json:"reason"`
	Result    *RunResult    `json:"result,omitempty"`
	Agent     *model.Agent  `json:"agent,omitempty"`
}

// SendBackResult is the plan and the round it makes.
type SendBackResult struct {
	plan.Plan
	Round int64 `json:"round"`
}

// AgentSendBack sends the item the agent holds back to an earlier agent step. The run ends as
// done, the reason is left as a note, and the round counter goes up by one.
func AgentSendBack(ctx Ctx, in AgentSendBackInput) (SendBackResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return SendBackResult{}, err
	}
	claim, err := OwnClaim(ctx, in.Item)
	if err != nil {
		return SendBackResult{}, err
	}
	step, err := stepOf(in.Project, in.Item.StepID)
	if err != nil {
		return SendBackResult{}, err
	}
	if step.Kind != "agent" {
		return SendBackResult{}, fail("Agents only send back from agent steps")
	}
	if err := RequireSendBackReason(in.Reason); err != nil {
		return SendBackResult{}, err
	}
	to, err := CheckSendBackTarget(in.Project, in.Item, in.ToStepID)
	if err != nil {
		return SendBackResult{}, err
	}
	round := AgentRounds(in.Item) + 1
	if round > MaxAgentSendBacks {
		return SendBackResult{}, fail("Agents already sent this item back " + strconv.Itoa(MaxAgentSendBacks) + " times: it needs people now")
	}
	cost := in.Item.CostEur
	if in.Result != nil {
		cost += orZero(in.Result.CostEur)
	}
	reason := jsTrim(in.Reason)
	p := Plan(ctx, "item.sentBack", Scope{sp(in.ProjectID), sp(in.ItemID), sp(claim.RunID)},
		map[string]any{"fromStepId": in.Item.StepID, "toStepId": to.ID, "toStepName": to.Name, "reason": reason, "round": round},
		func(eventID string) []plan.Op {
			ops := []plan.Op{
				{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID), Data: merge(Arrival(to), map[string]any{
					"progress": nil, "costEur": Num(cost), "agentSendBacks": round, "updatedAt": ServerTime(), "lastEventId": eventID,
				})},
				{Kind: "update", Path: model.Paths.Run(ctx.WorkspaceID, claim.RunID), Data: RunEnd(withStatus(in.Result, "done"), eventID)},
			}
			ops = append(ops, StreakOps(ctx, in.Agent, "done", eventID)...)
			return append(ops, plan.Op{Kind: "set", Path: model.Paths.Message(ctx.WorkspaceID, in.ProjectID, in.ItemID, eventID+"-note"),
				Data: MessageDoc(ctx, in.ProjectID, in.ItemID, "note", reason, nil, eventID)})
		}, "")
	return SendBackResult{Plan: p, Round: round}, nil
}

// StuckQuestion is the question an agent asks when the round limit is reached.
func StuckQuestion(reasons []string, next string) string {
	lines := make([]string, len(reasons))
	for i, r := range reasons {
		lines[i] = strconv.Itoa(i+1) + ". " + r
	}
	text := StuckQuestionPrefix + " and it still is not right. Please decide how to go on (answer to hand it back to the agents).\n\nReasons so far:\n" +
		strings.Join(lines, "\n") + "\n\nThis time: " + next
	if jsLen(text) > 8000 {
		return jsSlice(text, 7990) + "…"
	}
	return text
}
