package hive

// Scheduled tasks, slice 5: schedule_propose (an agent proposes a schedule on the member's
// thread, or revises its proposal after Ask for changes) and schedule_list (the member's
// schedules with their next runs). Cost (João: "as cheap as possible"): schedule_list is one
// query on the member's schedules; next runs are computed here, never read per run.

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// ScheduleProposeIn is schedule_propose's arguments.
type ScheduleProposeIn struct {
	ThreadID   string
	Title      string
	What       string
	Rule       map[string]any
	Steps      []actions.PlanStepInput
	Template   *string
	RunTitle   *string
	SubjectID  actions.OptString
	Note       *string
	Confidence *string
	Checks     []string
	// Revises: the schedule outcome the person asked changes for (its id).
	Revises *string
	// Replaces: an active (or paused) schedule this proposal changes.
	Replaces *string
}

func (c *Client) schedule(ctx context.Context, id string) (model.Schedule, error) {
	var s model.Schedule
	ok, err := c.getDoc(ctx, actions.SchedulePath(c.WorkspaceID, id), &s)
	if err != nil {
		return s, err
	}
	if !ok {
		return s, Errf(fmt.Sprintf("Schedule %s not found.", id))
	}
	return s, nil
}

// localRun is an occurrence in words for the agent: "Sun 1 Nov 2026 09:00 (Lisbon)".
func localRun(o actions.Occurrence, tz string) string {
	t := time.UnixMilli(o.DueMs)
	if loc, err := time.LoadLocation(tz); err == nil {
		t = t.In(loc)
	}
	return t.Format("Mon 2 Jan 2006 15:04") + " (" + actions.TZCity(tz) + ")"
}

// nextRunWords are the next n runs of a stored rule from max(now, from), in words.
func nextRunWords(rule map[string]any, from time.Time, n int) []string {
	out := []string{}
	r, err := actions.RuleOf(rule)
	if err != nil {
		return out
	}
	start := time.Now()
	if from.After(start) {
		start = from
	}
	for _, o := range actions.NextRuns(r, start.UnixMilli(), n) {
		out = append(out, localRun(o, r.TZ))
	}
	return out
}

// SchedulePropose proposes a schedule (schedule_propose), or with Revises its next version.
func (c *Client) SchedulePropose(ctx context.Context, in ScheduleProposeIn) (map[string]any, error) {
	steps := in.Steps
	var tpl *string
	if in.Template != nil && *in.Template != "" {
		var err error
		if steps, err = actions.FromTemplate(*in.Template, steps); err != nil {
			return nil, wrap(err)
		}
		tpl = in.Template
	}
	if steps == nil {
		steps = []actions.PlanStepInput{}
	}
	si := actions.ScheduleInput{Title: in.Title, What: in.What, Rule: in.Rule, RunTitle: in.RunTitle, Steps: steps, TemplateID: tpl, SubjectID: in.SubjectID.Val}
	var r actions.ProposeScheduleResult
	var threadID string
	if in.Revises != nil && *in.Revises != "" {
		o, err := c.outcome(ctx, *in.Revises)
		if err != nil {
			return nil, err
		}
		if o.Type != "schedule" {
			return nil, Errf(fmt.Sprintf("Outcome %s is a %s: revise it with outcome_propose.", *in.Revises, o.Type))
		}
		sid, _ := o.Fields["scheduleId"].(string)
		s, err := c.schedule(ctx, sid)
		if err != nil {
			return nil, err
		}
		t, err := c.thread(ctx, o.ThreadID)
		if err != nil {
			return nil, err
		}
		if in.ThreadID != "" && in.ThreadID != o.ThreadID {
			return nil, Errf(fmt.Sprintf("Outcome %s is on thread %s, not %s.", *in.Revises, o.ThreadID, in.ThreadID))
		}
		rin := actions.ReviseScheduleInput{ScheduleInput: si, OutcomeID: *in.Revises, Outcome: actions.OutcomeStateFrom(o), Thread: actions.ThreadStateFrom(t),
			Note: in.Note, Confidence: in.Confidence, Checks: in.Checks, Subject: in.SubjectID}
		rin.Schedule.ID, rin.Schedule.Data = sid, actions.ScheduleStateFrom(s)
		if r, err = actions.ReviseSchedule(c.actx(), rin); err != nil {
			return nil, wrap(err)
		}
		threadID = o.ThreadID
	} else {
		t, err := c.thread(ctx, in.ThreadID)
		if err != nil {
			return nil, err
		}
		if !in.SubjectID.Set {
			// Filed with the thread it was asked on, unless the agent names a subject.
			si.SubjectID = t.SubjectID
		}
		pin := actions.ProposeScheduleInput{ScheduleInput: si, ThreadID: in.ThreadID, Thread: actions.ThreadStateFrom(t), Note: in.Note, Confidence: in.Confidence, Checks: in.Checks}
		if in.Replaces != nil && *in.Replaces != "" {
			s, err := c.schedule(ctx, *in.Replaces)
			if err != nil {
				return nil, err
			}
			pin.Replaces = &struct {
				ID       string                `json:"id"`
				Schedule actions.ScheduleState `json:"schedule"`
			}{*in.Replaces, actions.ScheduleStateFrom(s)}
		}
		if r, err = actions.ProposeSchedule(c.actx(), pin); err != nil {
			return nil, wrap(err)
		}
		threadID = in.ThreadID
	}
	if err := c.inboxWrite(ctx, r.Plan); err != nil {
		return nil, err
	}
	rule, _ := actions.CleanRule(in.Rule)
	out := map[string]any{"scheduleId": r.ScheduleID, "outcomeId": r.OutcomeID, "threadId": threadID, "sentence": r.Sentence,
		"state": "proposed", "nextRuns": nextRunWords(rule, time.Now(), 3)}
	if r.Version > 0 {
		out["version"] = r.Version
		out["note"] = fmt.Sprintf("Version %d proposed in place of the earlier one. Nothing runs until the person approves it (Set up schedule); then Hivenod starts each run at its time and sends you its carry_out. Keep no timer of your own.", r.Version)
	} else {
		out["note"] = "Proposed. The person sees the schedule, its next runs and the plan of each run, and approves it (Set up schedule), asks for changes or says not now. Nothing runs before; once approved Hivenod starts each run at its time as a new thread with this plan and sends you its carry_out. Keep no timer of your own."
	}
	return out, nil
}

// ScheduleList is schedule_list: the member's schedules in this organization, next runs first.
func (c *Client) ScheduleList(ctx context.Context, member string) (map[string]any, error) {
	uid, err := c.inboxMember(ctx, member)
	if err != nil {
		return nil, err
	}
	docs, err := listInbox[model.Schedule](ctx, c, "schedules", "memberUid", "==", uid)
	if err != nil {
		return nil, err
	}
	type row struct {
		m    map[string]any
		next int64
	}
	rows := make([]row, 0, len(docs))
	for _, d := range docs {
		s := d.Data
		types := make([]string, len(s.Steps))
		for i, st := range s.Steps {
			types[i] = st.Type
		}
		m := map[string]any{"scheduleId": d.ID, "title": s.Title, "state": s.State, "agent": s.AgentUID,
			"yours": s.AgentUID == c.UID, "what": actions.JSSlice(s.What, 300), "steps": types, "subjectId": s.SubjectID}
		var next int64 = 1<<62 + int64(len(rows))
		if r, err := actions.RuleOf(s.Rule); err == nil {
			m["sentence"] = actions.RuleSentence(r)
			if s.State == "active" || s.State == "proposed" {
				from := time.Now()
				if s.ActiveFrom != nil && s.ActiveFrom.After(from) {
					from = *s.ActiveFrom
				}
				occ := actions.NextRuns(r, from.UnixMilli(), 3)
				words := make([]string, len(occ))
				for i, o := range occ {
					words[i] = localRun(o, r.TZ)
				}
				m["nextRuns"] = words
				if len(occ) > 0 && s.State == "active" {
					next = occ[0].DueMs
				}
			}
		} else {
			m["sentence"] = "(a rule this CLI cannot read)"
		}
		if s.Proposal != nil {
			m["proposal"] = map[string]any{"threadId": s.Proposal.ThreadID, "outcomeId": s.Proposal.OutcomeID}
		}
		if s.Replaces != nil {
			m["replaces"] = *s.Replaces
		}
		rows = append(rows, row{m, next})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].next < rows[j].next })
	list := make([]any, len(rows))
	for i, r := range rows {
		list[i] = r.m
	}
	return map[string]any{"member": uid, "schedules": list,
		"note": "Active schedules run by themselves (Hivenod starts each run and sends its carry_out to the agent that runs it). Before proposing, check that the same thing is not scheduled already; to change one you run, schedule_propose with replaces."}, nil
}
