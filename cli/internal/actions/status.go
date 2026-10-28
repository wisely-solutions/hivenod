package actions

import (
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Status checks on ongoing work (item AzveC; packages/shared/src/status.ts).

// StatusMinGap: a status may not be reported more often than this.
const StatusMinGap = 30 * time.Second

// StatusEveryOf is the project's status interval in minutes (0 = off).
func StatusEveryOf(p model.Project) int64 {
	if p.StatusEvery != nil {
		switch *p.StatusEvery {
		case 0, 15, 30, 60:
			return *p.StatusEvery
		}
	}
	return model.DefaultStatusEvery
}

// StatusOf is the status in force on an item: only while the claim it was written under holds.
func StatusOf(item model.Item) *model.StatusUpdate {
	if item.StatusUpdate != nil && item.Claim != nil && item.Claim.RunID == item.StatusUpdate.RunID {
		return item.StatusUpdate
	}
	return nil
}

// StatusAskOf is a person's ask for a status on the current claim, or nil.
func StatusAskOf(item model.Item) *model.StatusAsk {
	if item.StatusAsk != nil && item.Claim != nil && item.Claim.RunID == item.StatusAsk.RunID {
		return item.StatusAsk
	}
	return nil
}

// ActivelyWorked: claimed, working, not parked, not waiting for an answer, not stopped.
func ActivelyWorked(item model.Item) bool {
	return item.Status == "working" && item.Claim != nil && ParkOf(item) == nil &&
		item.AwaitingAnswer == nil && item.WorkStopped == nil
}

// ReportStatusInput is reportStatus's input.
type ReportStatusInput struct {
	ProjectID string     `json:"projectId"`
	ItemID    string     `json:"itemId"`
	Item      model.Item `json:"item"`
	Text      string     `json:"text"`
	Pct       *float64   `json:"pct"`
}

// ReportStatus is the one-line status of the item the agent holds, replacing the previous one.
func ReportStatus(ctx Ctx, in ReportStatusInput) (plan.Plan, error) {
	if err := RequireAgent(ctx); err != nil {
		return plan.Plan{}, err
	}
	claim, err := OwnClaim(ctx, in.Item)
	if err != nil {
		return plan.Plan{}, err
	}
	text := strings.Join(strings.FieldsFunc(in.Text, jsSpace), " ")
	if text == "" {
		return plan.Plan{}, fail("Say in one line where the work stands")
	}
	if jsLen(text) > model.MaxStatusTextChars {
		return plan.Plan{}, fail("Keep the status under " + strconv.Itoa(model.MaxStatusTextChars) + " characters")
	}
	var pct any
	var pctN *int64
	if in.Pct != nil {
		v := *in.Pct
		if v != math.Trunc(v) || v < 0 || v > 100 {
			return plan.Plan{}, fail("The percentage is a whole number from 0 to 100")
		}
		n := int64(v)
		pctN = &n
		pct = n
	}
	prev := StatusOf(in.Item)
	if prev != nil && ctx.now().Sub(prev.At) < StatusMinGap {
		return plan.Plan{}, fail("You reported a status less than 30 seconds ago: wait a little before the next one")
	}
	repeat := prev != nil && prev.Text == text && ((prev.Pct == nil && pctN == nil) || (prev.Pct != nil && pctN != nil && *prev.Pct == *pctN))
	su := map[string]any{"runId": claim.RunID, "text": text, "pct": pct, "at": ServerTime(), "by": ctx.Actor.ID}
	data := map[string]any{"status": map[string]any{"text": text, "pct": pct}}
	if repeat {
		data["repeat"] = true
	}
	return Plan(ctx, "item.updated", Scope{sp(in.ProjectID), sp(in.ItemID), sp(claim.RunID)}, data, func(eventID string) []plan.Op {
		return []plan.Op{{Kind: "update", Path: model.Paths.Item(ctx.WorkspaceID, in.ProjectID, in.ItemID),
			Data: map[string]any{"statusUpdate": su, "updatedAt": ServerTime(), "lastEventId": eventID}}}
	}, ""), nil
}
