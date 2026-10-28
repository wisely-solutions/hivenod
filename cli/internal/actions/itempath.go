package actions

import "github.com/wisely-solutions/hivenod/cli/internal/model"

// itempath.ts and stopwork.ts isOnHold.

// IsUnshaped: shape is null (a new item waiting to be shaped). Absent shape = an item from before paths.
func IsUnshaped(item model.Item) bool { return item.HasShape && item.Shape == nil }

// IsShaped: shaped by an agent or a person.
func IsShaped(item model.Item) bool { return item.Shape != nil }

// Skips: an agent step by the item's pathSkips, a people step only by its gateSkips.
func Skips(item model.Item, step model.Step) bool {
	m := item.GateSkips
	if step.Kind == "agent" {
		m = item.PathSkips
	}
	_, ok := m[step.ID]
	return ok
}

// SkipReason is why the item skips step ("" when no reason was given).
func SkipReason(item model.Item, step model.Step) string {
	if step.Kind == "agent" {
		return item.PathSkips[step.ID]
	}
	return item.GateSkips[step.ID]
}

// PathOf is the step ids on the item's path, in library order.
func PathOf(project model.Project, item model.Item) []string {
	out := []string{}
	for _, s := range project.Steps {
		if !Skips(item, s) {
			out = append(out, s.ID)
		}
	}
	return out
}

// PathStep is one library step with what it is for an item.
type PathStep struct {
	Step model.Step
	// State: done, current, ahead, skipped or proposed.
	State string
	// Request: a pending people-step change ("add" or "drop"), or "".
	Request string
	// Note: why it is skipped, or "".
	Note string
}

// StepsOnPath is every library step with its state for this item.
func StepsOnPath(project model.Project, item model.Item) []PathStep {
	cur := -1
	for i, s := range project.Steps {
		if s.ID == item.StepID {
			cur = i
			break
		}
	}
	finished := item.Status == "done"
	out := make([]PathStep, 0, len(project.Steps))
	for i, step := range project.Steps {
		request := ""
		if r, ok := item.PathRequests[step.ID]; ok {
			request = r.Op
		}
		var state string
		skipped := Skips(item, step)
		switch {
		case skipped && request == "add":
			state = "proposed"
		case skipped:
			state = "skipped"
		case i < cur || (finished && i == cur):
			state = "done"
		case i == cur:
			state = "current"
		default:
			state = "ahead"
		}
		ps := PathStep{Step: step, State: state, Request: request}
		if skipped {
			ps.Note = SkipReason(item, step)
		}
		out = append(out, ps)
	}
	return out
}

// NextOnPath is the next step on the item's path after stepID, or nil.
func NextOnPath(project model.Project, item model.Item, stepID string) *model.Step {
	i := -1
	for j, s := range project.Steps {
		if s.ID == stepID {
			i = j
			break
		}
	}
	// TS: steps.slice(i + 1): an unknown step (-1) searches from the start.
	for _, s := range project.Steps[i+1:] {
		if !Skips(item, s) {
			s := s
			return &s
		}
	}
	return nil
}

// FirstOnPath is the first step on the path (where a newly shaped item arrives), or nil.
func FirstOnPath(project model.Project, item model.Item) *model.Step {
	for _, s := range project.Steps {
		if !Skips(item, s) {
			s := s
			return &s
		}
	}
	return nil
}

// IsOnHold: held after "Go back" until someone presses Resume; no agent may claim it.
func IsOnHold(item model.Item) bool {
	return item.WorkStopped != nil && item.WorkStopped.Mode == "back" && item.Status != "stopped"
}
