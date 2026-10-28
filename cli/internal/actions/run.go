package actions

import (
	"math"
	"strconv"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Claims, heartbeats, run ends (actions.ts).

// Takeover names a stale claim's open run, ended as released in the claim's batch.
type Takeover struct {
	RunID string `json:"runId"`
}

// ClaimItemInput is claimItem's input.
type ClaimItemInput struct {
	ProjectID string     `json:"projectId"`
	ItemID    string     `json:"itemId"`
	Item      model.Item `json:"item"`
	// RunID defaults to a new id.
	RunID    string    `json:"runId,omitempty"`
	Takeover *Takeover `json:"takeover,omitempty"`
	// Job "shape": a shaping run on an unshaped item.
	Job string `json:"job,omitempty"`
}

// ClaimResult is the plan and the new run's id.
type ClaimResult struct {
	plan.Plan
	RunID string `json:"runId"`
}

// ClaimItem claims an item at an agent step (unclaimed, or stale) and starts a run.
func ClaimItem(ctx Ctx, in ClaimItemInput) (ClaimResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ClaimResult{}, err
	}
	runID := in.RunID
	if runID == "" {
		runID = ctx.nid()
	}
	w, actor := ctx.WorkspaceID, ctx.Actor
	var takeover any
	if in.Item.Claim != nil {
		takeover = in.Item.Claim.AgentUID
	}
	data := map[string]any{"stepId": in.Item.StepID, "takeover": takeover}
	if in.Job != "" {
		data["job"] = in.Job
	}
	p := Plan(ctx, "item.claimed", Scope{sp(in.ProjectID), sp(in.ItemID), sp(runID)}, data, func(eventID string) []plan.Op {
		run := map[string]any{
			"agentUid":         actor.ID,
			"projectId":        in.ProjectID,
			"itemId":           in.ItemID,
			"stepId":           in.Item.StepID,
			"startedAt":        ServerTime(),
			"heartbeatAt":      ServerTime(),
			"heartbeatEventAt": ServerTime(),
			"endedAt":          nil,
			"status":           "running",
			"costEur":          int64(0),
			"tokensIn":         int64(0),
			"tokensOut":        int64(0),
			"model":            nil,
			"summary":          nil,
			"lastEventId":      eventID,
		}
		if in.Job != "" {
			run["job"] = in.Job
		}
		ops := []plan.Op{
			{Kind: "set", Path: model.Paths.Run(w, runID), Data: run},
			{Kind: "update", Path: model.Paths.Item(w, in.ProjectID, in.ItemID), Data: map[string]any{
				"claim":       map[string]any{"runId": runID, "agentUid": actor.ID, "heartbeatAt": ServerTime()},
				"status":      "working",
				"updatedAt":   ServerTime(),
				"lastEventId": eventID,
			}},
		}
		if in.Takeover != nil && in.Takeover.RunID != runID {
			ops = append(ops, plan.Op{Kind: "update", Path: model.Paths.Run(w, in.Takeover.RunID), Data: map[string]any{
				"status":      "released",
				"endedAt":     ServerTime(),
				"summary":     jsSlice("Taken over by "+actor.Name+": no heartbeat for 10 minutes.", 4000),
				"lastEventId": eventID,
			}})
		}
		return ops
	}, "")
	return ClaimResult{Plan: p, RunID: runID}, nil
}

// HeartbeatEventAfterMs: how long after the last run.heartbeat event a new one is written.
const HeartbeatEventAfterMs = 5.5 * 60 * 1000

// RunUsage is a run's running totals (they only ever grow).
type RunUsage struct {
	TokensIn     float64  `json:"tokensIn"`
	TokensOut    float64  `json:"tokensOut"`
	TokensCached *float64 `json:"tokensCached,omitempty"`
	// Model: not given = leave it; null or "" = null.
	Model   Maybe[string] `json:"model"`
	CostEur *float64      `json:"costEur,omitempty"`
}

func usageFields(u RunUsage) map[string]any {
	whole := func(n float64) float64 { return math.Max(0, jsRound(n)) }
	tokensIn := whole(u.TokensIn)
	out := map[string]any{"tokensIn": Num(tokensIn), "tokensOut": Num(whole(u.TokensOut))}
	if u.TokensCached != nil {
		out["tokensCached"] = Num(math.Min(whole(*u.TokensCached), tokensIn))
	}
	if u.Model.Set {
		if u.Model.V != nil && *u.Model.V != "" {
			out["model"] = jsSlice(*u.Model.V, 80)
		} else {
			out["model"] = nil
		}
	}
	if u.CostEur != nil && !math.IsInf(*u.CostEur, 0) && !math.IsNaN(*u.CostEur) {
		out["costEur"] = Num(math.Max(0, *u.CostEur))
	}
	return out
}

// HeartbeatInput is heartbeat's input.
type HeartbeatInput struct {
	ProjectID              string `json:"projectId"`
	ItemID                 string `json:"itemId"`
	RunID                  string `json:"runId"`
	LastHeartbeatEventAtMs int64  `json:"lastHeartbeatEventAtMs"`
	// NowMs defaults to ctx.Now.
	NowMs *int64    `json:"nowMs,omitempty"`
	Usage *RunUsage `json:"usage,omitempty"`
}

// Heartbeat returns a plan with a run.heartbeat event when one is due, or EventID "" with plain
// updates otherwise (plan.Apply commits either).
func Heartbeat(ctx Ctx, in HeartbeatInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	w := ctx.WorkspaceID
	usage := map[string]any{}
	if in.Usage != nil {
		usage = usageFields(*in.Usage)
	}
	itemOp := plan.Op{Kind: "update", Path: model.Paths.Item(w, in.ProjectID, in.ItemID), Data: map[string]any{"claim.heartbeatAt": ServerTime()}}
	now := ctx.now().UnixMilli()
	if in.NowMs != nil {
		now = *in.NowMs
	}
	if float64(now-in.LastHeartbeatEventAtMs) < HeartbeatEventAfterMs {
		return plan.Plan{Ops: []plan.Op{
			{Kind: "update", Path: model.Paths.Run(w, in.RunID), Data: merge(map[string]any{"heartbeatAt": ServerTime()}, usage)},
			itemOp,
		}}, nil
	}
	return Plan(ctx, "run.heartbeat", Scope{sp(in.ProjectID), sp(in.ItemID), sp(in.RunID)}, map[string]any{}, func(eventID string) []plan.Op {
		return []plan.Op{
			{Kind: "update", Path: model.Paths.Run(w, in.RunID), Data: merge(
				map[string]any{"heartbeatAt": ServerTime(), "heartbeatEventAt": ServerTime()},
				usage,
				map[string]any{"lastEventId": eventID},
			)},
			itemOp,
		}
	}, ""), nil
}

// LogLineInput is logLine's input.
type LogLineInput struct {
	RunID string `json:"runId"`
	N     int    `json:"n"`
	Level string `json:"level"`
	Text  string `json:"text"`
}

// LogLine is one log line write (no event).
func LogLine(ctx Ctx, in LogLineInput) (plan.Op, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Op{}, err
	}
	if in.N < 0 || in.N >= model.MaxLogLines {
		return plan.Op{}, fail("A run keeps at most " + strconv.Itoa(model.MaxLogLines) + " log lines")
	}
	return plan.Op{Kind: "set", Path: model.Paths.LogLine(ctx.WorkspaceID, in.RunID, in.N), Data: map[string]any{
		"at": ServerTime(), "level": in.Level, "text": jsSlice(in.Text, 4000),
	}}, nil
}

// RunResult is how a run ended (Status "done", "failed" or "released"; ignored where the action
// sets it).
type RunResult struct {
	Status       string   `json:"status,omitempty"`
	CostEur      *float64 `json:"costEur,omitempty"`
	TokensIn     *float64 `json:"tokensIn,omitempty"`
	TokensOut    *float64 `json:"tokensOut,omitempty"`
	TokensCached *float64 `json:"tokensCached,omitempty"`
	Model        *string  `json:"model,omitempty"`
	Summary      *string  `json:"summary,omitempty"`
}

func orZero(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

func orNull(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

// RunEnd is the run fields of a run's end.
func RunEnd(r RunResult, eventID string) map[string]any {
	tokensIn := orZero(r.TokensIn)
	out := map[string]any{
		"status":      r.Status,
		"endedAt":     ServerTime(),
		"heartbeatAt": ServerTime(),
		"costEur":     Num(orZero(r.CostEur)),
		"tokensIn":    Num(tokensIn),
		"tokensOut":   Num(orZero(r.TokensOut)),
		"model":       orNull(r.Model),
		"summary":     orNull(r.Summary),
		"lastEventId": eventID,
	}
	if r.TokensCached != nil {
		out["tokensCached"] = Num(math.Min(*r.TokensCached, tokensIn))
	}
	return out
}

func withStatus(r *RunResult, status string) RunResult {
	var out RunResult
	if r != nil {
		out = *r
	}
	out.Status = status
	return out
}

// StreakOps writes the agent's own failure streak in the batch that ends its run.
func StreakOps(ctx Ctx, agent *model.Agent, status, eventID string) []plan.Op {
	if agent == nil {
		return nil
	}
	next := StreakAfter(*agent, status)
	if next == nil {
		return nil
	}
	data := map[string]any{"failStreak": next.FailStreak, "lastEventId": eventID}
	if next.Pause {
		data["pausedAt"] = ServerTime()
		data["pausedReason"] = strconv.FormatInt(next.FailStreak, 10) + " failed runs in a row"
	}
	return []plan.Op{{Kind: "update", Path: model.Paths.Agent(ctx.WorkspaceID, ctx.Actor.ID), Data: data}}
}

func pauseData(agent *model.Agent, status string) map[string]any {
	if agent == nil {
		return map[string]any{}
	}
	if next := StreakAfter(*agent, status); next != nil && next.Pause {
		return map[string]any{"agentPaused": true, "failStreak": next.FailStreak}
	}
	return map[string]any{}
}

// ReleaseClaimInput is releaseClaim's input.
type ReleaseClaimInput struct {
	ProjectID string     `json:"projectId"`
	ItemID    string     `json:"itemId"`
	Item      model.Item `json:"item"`
	Result    *RunResult `json:"result,omitempty"`
	// Status "failed" or "released" (default).
	Status string       `json:"status,omitempty"`
	Agent  *model.Agent `json:"agent,omitempty"`
	// HoldFor: a question this agent just asked; the item is held until people answer it.
	HoldFor string `json:"holdFor,omitempty"`
	// RunEnded: the run already ended; only the item's claim is cleared.
	RunEnded bool `json:"runEnded,omitempty"`
}

// ReleaseClaim gives the item back (claim cleared, run ends as released or failed).
func ReleaseClaim(ctx Ctx, in ReleaseClaimInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	claim, err := OwnClaim(ctx, in.Item)
	if err != nil {
		return plan.Plan{}, err
	}
	status := in.Status
	if status == "" {
		status = "released"
	}
	data := map[string]any{}
	if status == "failed" {
		data["runStatus"] = "failed"
	}
	data = merge(data, pauseData(in.Agent, status))
	if in.HoldFor != "" {
		data["awaitingAnswer"] = in.HoldFor
	}
	return Plan(ctx, "item.released", Scope{sp(in.ProjectID), sp(in.ItemID), sp(claim.RunID)}, data, func(eventID string) []plan.Op {
		cost := 0.0
		if !in.RunEnded && in.Result != nil {
			cost = orZero(in.Result.CostEur)
		}
		item := map[string]any{
			"claim":       nil,
			"status":      "queued",
			"costEur":     Num(in.Item.CostEur + cost),
			"updatedAt":   ServerTime(),
			"lastEventId": eventID,
		}
		if in.HoldFor != "" {
			item["awaitingAnswer"] = map[string]any{"questionId": in.HoldFor, "agentUid": ctx.Actor.ID, "at": ServerTime()}
		}
		ops := []plan.Op{{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID), Data: item}}
		if !in.RunEnded {
			ops = append(ops, plan.Op{Kind: "update", Path: model.Paths.Run(ctx.WorkspaceID, claim.RunID), Data: RunEnd(withStatus(in.Result, status), eventID)})
			ops = append(ops, StreakOps(ctx, in.Agent, status, eventID)...)
		}
		return ops
	}, ""), nil
}

// ProgressInput is {done, total}.
type ProgressInput struct {
	Done  float64 `json:"done"`
	Total float64 `json:"total"`
}

// ReportProgressInput is reportProgress's input.
type ReportProgressInput struct {
	ProjectID string     `json:"projectId"`
	ItemID    string     `json:"itemId"`
	Item      model.Item `json:"item"`
	// Progress: not given = unchanged; null = cleared.
	Progress Maybe[ProgressInput] `json:"progress"`
	CostEur  *float64             `json:"costEur,omitempty"`
}

// ReportProgress reports progress and/or cost on the item the agent holds.
func ReportProgress(ctx Ctx, in ReportProgressInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	claim, err := OwnClaim(ctx, in.Item)
	if err != nil {
		return plan.Plan{}, err
	}
	data := map[string]any{}
	if in.Progress.Set {
		if in.Progress.V == nil {
			data["progress"] = nil
		} else {
			data["progress"] = map[string]any{"done": Num(in.Progress.V.Done), "total": Num(in.Progress.V.Total)}
		}
	}
	if in.CostEur != nil {
		data["costEur"] = Num(*in.CostEur)
	}
	return Plan(ctx, "item.updated", Scope{sp(in.ProjectID), sp(in.ItemID), sp(claim.RunID)}, data, func(eventID string) []plan.Op {
		return []plan.Op{{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID),
			Data: merge(data, map[string]any{"updatedAt": ServerTime(), "lastEventId": eventID})}}
	}, ""), nil
}

// CompleteStepInput is completeStep's input.
type CompleteStepInput struct {
	Project   model.Project `json:"project"`
	ProjectID string        `json:"projectId"`
	ItemID    string        `json:"itemId"`
	Item      model.Item    `json:"item"`
	Result    *RunResult    `json:"result,omitempty"`
	Agent     *model.Agent  `json:"agent,omitempty"`
}

// CompleteStep finishes the agent's step: one step forward on the path, the run ends as done.
func CompleteStep(ctx Ctx, in CompleteStepInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	claim, err := OwnClaim(ctx, in.Item)
	if err != nil {
		return plan.Plan{}, err
	}
	step, err := stepOf(in.Project, in.Item.StepID)
	if err != nil {
		return plan.Plan{}, err
	}
	if step.Kind != "agent" {
		return plan.Plan{}, fail("Agents only complete agent steps")
	}
	to := Forward(in.Project, in.Item)
	cost := in.Item.CostEur
	if in.Result != nil {
		cost += orZero(in.Result.CostEur)
	}
	return Plan(ctx, "item.completed", Scope{sp(in.ProjectID), sp(in.ItemID), sp(claim.RunID)},
		map[string]any{"fromStepId": in.Item.StepID, "toStepId": to["stepId"], "status": to["status"]},
		func(eventID string) []plan.Op {
			ops := []plan.Op{
				{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID), Data: merge(to, map[string]any{
					"progress": nil, "costEur": Num(cost), "updatedAt": ServerTime(), "lastEventId": eventID,
				})},
				{Kind: "update", Path: model.Paths.Run(ctx.WorkspaceID, claim.RunID), Data: RunEnd(withStatus(in.Result, "done"), eventID)},
			}
			return append(ops, StreakOps(ctx, in.Agent, "done", eventID)...)
		}, ""), nil
}

// EndRunInput is endRun's input.
type EndRunInput struct {
	ProjectID string       `json:"projectId"`
	ItemID    string       `json:"itemId"`
	RunID     string       `json:"runId"`
	Result    RunResult    `json:"result"`
	Agent     *model.Agent `json:"agent,omitempty"`
}

// EndRun ends a run without completing; the claim stays until released or stale.
func EndRun(ctx Ctx, in EndRunInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	data := merge(map[string]any{"status": in.Result.Status}, pauseData(in.Agent, in.Result.Status))
	return Plan(ctx, "run.ended", Scope{sp(in.ProjectID), sp(in.ItemID), sp(in.RunID)}, data, func(eventID string) []plan.Op {
		ops := []plan.Op{{Kind: "update", Path: model.Paths.Run(ctx.WorkspaceID, in.RunID), Data: RunEnd(in.Result, eventID)}}
		return append(ops, StreakOps(ctx, in.Agent, in.Result.Status, eventID)...)
	}, ""), nil
}
