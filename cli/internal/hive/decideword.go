package hive

// May act on my word (packages/shared/src/decideword.ts): step_decide records the person's
// decision at a person step of a plan on a thread this agent is the home agent of, while the
// person has turned "May act on my word" on for it (Agents page); tidy_list lists the finished
// threads such a decision would tidy up. The rules enforce the trust; this client checks it first
// to say so plainly.

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

type agentTrustDoc struct {
	Agents []string `firestore:"agents"`
}

// trustedBy reports whether the member turned "May act on my word" on for this agent.
func (c *Client) trustedBy(ctx context.Context, member string) (bool, error) {
	var t agentTrustDoc
	ok, err := c.getDoc(ctx, model.Paths.AgentTrust(c.WorkspaceID, member), &t)
	if err != nil || !ok {
		return false, err
	}
	return contains(t.Agents, c.UID), nil
}

// memberName is the member's name on their card in this organization ("" when unknown).
func (c *Client) memberName(ctx context.Context, uid string) string {
	var m struct {
		Name string `firestore:"name"`
	}
	if ok, err := c.getDoc(ctx, model.Paths.Member(c.WorkspaceID, uid), &m); err != nil || !ok {
		return ""
	}
	return m.Name
}

func notTrusted(name string) error {
	who := name
	if who == "" {
		who = "The person"
	}
	return Errf(who + " has not turned on “May act on my word” for you (Agents page in Hivenod), so you cannot decide for them: ask them to decide in Hivenod instead (step_ask or inbox_ask).")
}

// StepDecide is step_decide: the person's decision, on their own words typed in this session.
func (c *Client) StepDecide(ctx context.Context, threadID string, outcomeID *string, decision, words string, toStep *float64) (map[string]any, error) {
	if threadID == "" {
		return nil, Errf("Give the thread (threadId).")
	}
	if !contains(actions.StepDecisions, decision) {
		return nil, Errf("decision is approve, accept, reject, changes or close.")
	}
	t, err := c.thread(ctx, threadID)
	if err != nil {
		return nil, err
	}
	if t.FetchedBy != c.UID {
		return nil, Errf("You decide on the person’s word only on threads you are the home agent of.")
	}
	name := c.memberName(ctx, t.MemberUID)
	ok, err := c.trustedBy(ctx, t.MemberUID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, notTrusted(name)
	}
	in := actions.DecideOnWordInput{Decision: decision, Words: words, ThreadID: threadID, Thread: actions.ThreadStateFrom(t), MemberName: name}
	var step any
	if decision != "close" {
		pl, oid, err := c.decisionPlan(ctx, threadID, outcomeID)
		if err != nil {
			return nil, err
		}
		in.Plan = pl
		in.OutcomeID = &oid
		if o, ok := pl.Outcomes[oid]; ok {
			step = actions.StepLabelOf(&o)
		}
		if toStep != nil {
			n := int(*toStep) - 1
			in.ToStep = &n
		}
	}
	p, err := actions.DecideOnWord(c.actx(), in)
	if err != nil {
		return nil, wrap(err)
	}
	if err := c.inboxWrite(ctx, p); err != nil {
		return nil, err
	}
	who := name
	if who == "" {
		who = "the person"
	}
	out := map[string]any{"threadId": threadID, "decision": decision, "onBehalfOf": t.MemberUID,
		"note": fmt.Sprintf("Recorded as %s’s decision via your terminal, with their words. Tell them what changed.", who)}
	if in.OutcomeID != nil {
		out["outcomeId"] = *in.OutcomeID
		out["step"] = step
	}
	return out, nil
}

// decisionPlan is the plan the decision is about: the one with the named step, else the thread's
// live plan at its turn.
func (c *Client) decisionPlan(ctx context.Context, threadID string, outcomeID *string) (*actions.PlanInput, string, error) {
	if outcomeID != nil && *outcomeID != "" {
		o, err := c.outcome(ctx, *outcomeID)
		if err != nil {
			return nil, "", err
		}
		if o.ThreadID != threadID || o.PlanID == nil {
			return nil, "", Errf("Name a person step of this thread’s plan (outcomeId).")
		}
		in, _, err := c.planInput(ctx, *o.PlanID)
		if err != nil {
			return nil, "", err
		}
		return &in, *outcomeID, nil
	}
	pl, err := c.livePlan(ctx, threadID)
	if err != nil {
		return nil, "", err
	}
	if pl == nil || pl.Plan.Cursor >= len(pl.Plan.Steps) {
		return nil, "", Errf("This thread has no plan step at its turn: name the step (outcomeId).")
	}
	return pl, pl.Plan.Steps[pl.Plan.Cursor], nil
}

var acceptStep = regexp.MustCompile(`(?i)^accept\b`)

// TidyList is tidy_list: the finished threads of this agent a decision on the person's word
// would tidy up. Nothing changes here.
func (c *Client) TidyList(ctx context.Context) (map[string]any, error) {
	ths, err := listInbox[model.InboxThread](ctx, c, "inboxThreads", "fetchedBy", "==", c.UID)
	if err != nil {
		return nil, err
	}
	sort.SliceStable(ths, func(i, j int) bool { return ths[i].ID < ths[j].ID })
	rows := []any{}
	trusted := map[string]bool{}
	names := map[string]string{}
	for _, th := range ths {
		t := th.Data
		if t.State == "ignored" {
			continue
		}
		if _, seen := trusted[t.MemberUID]; !seen {
			ok, err := c.trustedBy(ctx, t.MemberUID)
			if err != nil {
				return nil, err
			}
			trusted[t.MemberUID] = ok
			names[t.MemberUID] = c.memberName(ctx, t.MemberUID)
		}
		add := func(kind, decision string, extra map[string]any, why string) {
			r := map[string]any{"threadId": th.ID, "title": t.Title, "member": names[t.MemberUID], "kind": kind, "why": why}
			if decision != "" {
				r["decision"] = decision
			}
			for k, v := range extra {
				r[k] = v
			}
			rows = append(rows, r)
		}
		if t.State != "done" {
			ps, err := c.threadPlans(ctx, th.ID)
			if err != nil {
				return nil, err
			}
			for i, pd := range ps {
				p := pd.Data
				if p.State == "proposed" && i < len(ps)-1 {
					step := ""
					if len(p.Steps) > 0 {
						step = p.Steps[0]
					}
					add("replaced", "reject", map[string]any{"planId": pd.ID, "outcomeId": step},
						"A proposed plan a newer plan replaced: reject it.")
				}
			}
			if n := len(ps); n > 0 {
				last := ps[n-1]
				switch last.Data.State {
				case "done":
					add("done", "close", map[string]any{"planId": last.ID}, "Its plan is done but the thread is still open: close it.")
				case "active":
					in, _, err := c.planInput(ctx, last.ID)
					if err != nil {
						return nil, err
					}
					cur := last.Data.Cursor
					if cur < len(in.Plan.Steps) {
						oid := in.Plan.Steps[cur]
						o, ok := in.Outcomes[oid]
						prev := in.Outcomes[stepAt(in.Plan.Steps, cur-1)]
						label, _ := actions.StepLabelOf(&o).(string)
						if ok && o.State == "proposed" && actions.OutcomeKind(o.Type) == "human" &&
							acceptStep.MatchString(label) && prev.State == "done" {
							add("accept", "accept", map[string]any{"planId": last.ID, "outcomeId": oid, "step": label, "since": cursorSince(last.Data)},
								"Released and live-checked, waiting at "+label+": accept it once the person says it works live.")
						}
					}
				}
			}
		}
		if summaryState(t) == "stale" {
			add("resummarize", "", nil, "The summary is older than the thread: re-read it (thread_read) and write it again (thread_summary).")
		}
	}
	untrusted := []string{}
	for m, ok := range trusted {
		if !ok {
			n := names[m]
			if n == "" {
				n = m
			}
			untrusted = append(untrusted, n)
		}
	}
	sort.Strings(untrusted)
	note := "Show the person this list. Only on their own words typed in this session: step_decide each one they OK (its decision and outcomeId), re-summarize the stale ones yourself, then report what changed."
	if len(untrusted) > 0 {
		note += " Not trusted by " + strings.Join(untrusted, ", ") + ": they decide those in Hivenod themselves."
	}
	return map[string]any{"candidates": rows, "note": note}, nil
}

func stepAt(steps []string, i int) string {
	if i < 0 || i >= len(steps) {
		return ""
	}
	return steps[i]
}

func cursorSince(p model.InboxPlan) any {
	if p.CursorAt != nil {
		return p.CursorAt.UTC().Format(time.RFC3339)
	}
	return nil
}
