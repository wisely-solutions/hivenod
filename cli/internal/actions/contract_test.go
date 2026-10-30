package actions

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	"sort"
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// The contract: testdata/contract.json is what the TypeScript actions return for each case
// (cli/contract/cases.ts, kept current by scripts/go-contract.test.mjs). Every case runs here
// through its Go runner and must give the same output.

type contractCase struct {
	Name   string          `json:"name"`
	Action string          `json:"action"`
	Ctx    *Ctx            `json:"ctx"`
	Input  json.RawMessage `json:"input"`
	Output json.RawMessage `json:"output"`
}

type contractFile struct {
	NowMs int64          `json:"nowMs"`
	Cases []contractCase `json:"cases"`
}

type runner func(ctx Ctx, input []byte) (any, error)

// decode is a strict json decode of a case input.
func decode[T any](input []byte) (T, error) {
	var v T
	d := json.NewDecoder(bytes.NewReader(input))
	d.DisallowUnknownFields()
	err := d.Decode(&v)
	return v, err
}

// act runs an action that takes (ctx, input struct).
func act[I any, O any](f func(Ctx, I) (O, error)) runner {
	return func(ctx Ctx, input []byte) (any, error) {
		in, err := decode[I](input)
		if err != nil {
			return nil, err
		}
		return f(ctx, in)
	}
}

// pure runs a helper on a decoded input struct.
func pure[I any](f func(I) (any, error)) runner {
	return func(_ Ctx, input []byte) (any, error) {
		in, err := decode[I](input)
		if err != nil {
			return nil, err
		}
		return f(in)
	}
}

type projItem struct {
	Project model.Project `json:"project"`
	Item    model.Item    `json:"item"`
}

func ids(steps []model.Step) []string {
	out := make([]string, len(steps))
	for i, s := range steps {
		out[i] = s.ID
	}
	return out
}

func stepID(s *model.Step) any {
	if s == nil {
		return nil
	}
	return s.ID
}

var runners = map[string]runner{
	"claimItem": act(ClaimItem),
	"heartbeat": act(func(ctx Ctx, in HeartbeatInput) (any, error) {
		p, err := Heartbeat(ctx, in)
		if err != nil {
			return nil, err
		}
		var eventID any
		if p.EventID != "" {
			eventID = p.EventID
		}
		return map[string]any{"eventId": eventID, "ops": p.Ops}, nil
	}),
	"logLine":        act(LogLine),
	"releaseClaim":   act(ReleaseClaim),
	"reportProgress": act(ReportProgress),
	"parkItem":       act(ParkItem),
	"reportStatus":   act(ReportStatus),
	"statusEveryOf":  pure(func(in model.Project) (any, error) { return StatusEveryOf(in), nil }),
	"unparkItem":     act(UnparkItem),
	"completeStep":   act(CompleteStep),
	"endRun":         act(EndRun),
	"attach":         act(Attach),
	"postMessage":    act(PostMessage),
	"raiseFinding":   act(RaiseFinding),
	"createItem":     act(CreateItem),
	"agentSendBack":  act(AgentSendBack),
	"shapeItem":      act(ShapeItem),
	"skipStep":       act(SkipStep),
	"askPathChange":  act(AskPathChange),
	"proposeStep":    act(ProposeStep),
	// Inbox (item 4PEHrOW5IfXBQWgOK9wo)
	"addInboxMessage":   act(AddInboxMessage),
	"assignSubject":     act(AssignSubject),
	"addThreadNote":     act(AddThreadNote),
	"askMember":         act(AskMember),
	"retitleThread":     act(RetitleThread),
	"proposeOutcome":    act(ProposeOutcome),
	"finishOutcome":     act(FinishOutcome),
	"reviseOutcome":     act(ReviseOutcome),
	"recheckDone":       act(RecheckDone),
	"answerInstruction": act(AnswerInstruction),
	"suggestChips":      act(SuggestChips),
	// Thread summaries (item OE8FmrTaIxFVGcaeGG3N)
	"writeSummary": act(WriteSummary),
	"threadAttach": act(ThreadAttach),
	"checkSummary": pure(func(in struct {
		Summary any `json:"summary"`
	}) (any, error) {
		return CheckSummary(in.Summary)
	}),
	"wakeThread":   act(WakeThread),
	"proposePlan":  act(ProposePlan),
	"sendBackPlan": act(SendBackPlan),
	"stepProgress": act(StepProgress),
	"planThreadState": pure(func(in struct {
		Plan     PlanState               `json:"plan"`
		Outcomes map[string]OutcomeState `json:"outcomes"`
	}) (any, error) {
		return PlanThreadState(in.Plan, in.Outcomes)
	}),
	"planView": pure(func(in struct {
		Plan     PlanState               `json:"plan"`
		Outcomes map[string]OutcomeState `json:"outcomes"`
	}) (any, error) {
		return PlanView(in.Plan, in.Outcomes), nil
	}),
	"cleanOutcomeFields": pure(func(in struct {
		Type   string         `json:"type"`
		Fields map[string]any `json:"fields"`
	}) (any, error) {
		return CleanOutcomeFields(in.Type, in.Fields)
	}),
	"threadAfter": pure(func(in struct {
		Type   string         `json:"type"`
		Fields map[string]any `json:"fields"`
	}) (any, error) {
		return ThreadAfter(in.Type, in.Fields)
	}),
	"inboxKeys": pure(func(in struct {
		Member    string `json:"member"`
		Source    string `json:"source"`
		ThreadRef string `json:"threadRef"`
		MessageID string `json:"messageId"`
	}) (any, error) {
		return map[string]any{"message": InboxMessageKey(in.Member, in.Source, in.ThreadRef, in.MessageID), "thread": InboxThreadKey(in.Member, in.Source, in.ThreadRef)}, nil
	}),
	"titleFrom": pure(func(in struct {
		Text string `json:"text"`
	}) (any, error) {
		return TitleFrom(in.Text), nil
	}),
	"flagThread":      act(FlagThread),
	"dueThread":       act(DueThread),
	"proposeRelation": act(ProposeRelation),
	"relationId": pure(func(in struct {
		A string `json:"a"`
		B string `json:"b"`
	}) (any, error) {
		return RelationID(in.A, in.B), nil
	}),
	"searchSubjects": pure(func(in SearchInput) (any, error) { return SearchSubjects(in), nil }),

	"agentSendBackTargets": pure(func(in projItem) (any, error) {
		return ids(AgentSendBackTargets(in.Project, in.Item)), nil
	}),
	"checkSendBackTarget": pure(func(in struct {
		projItem
		ToStepID string `json:"toStepId"`
	}) (any, error) {
		s, err := CheckSendBackTarget(in.Project, in.Item, in.ToStepID)
		return s.ID, err
	}),
	"requireSendBackReason": pure(func(in struct {
		Reason string `json:"reason"`
	}) (any, error) {
		return nil, RequireSendBackReason(in.Reason)
	}),
	"agentRounds": pure(func(in struct {
		Item model.Item `json:"item"`
	}) (any, error) {
		return AgentRounds(in.Item), nil
	}),
	"stuckQuestion": pure(func(in struct {
		Reasons []string `json:"reasons"`
		Next    string   `json:"next"`
	}) (any, error) {
		return StuckQuestion(in.Reasons, in.Next), nil
	}),
	"constants": pure(func(struct{}) (any, error) {
		return map[string]any{
			"MAX_AGENT_SEND_BACKS":     MaxAgentSendBacks,
			"STUCK_QUESTION_PREFIX":    StuckQuestionPrefix,
			"HEARTBEAT_EVENT_AFTER_MS": HeartbeatEventAfterMs,
			"AGENT_ONLINE_MS":          AgentOnlineMs,
		}, nil
	}),
	"planPathChange": pure(func(in struct {
		projItem
		Actor  model.ActorRef `json:"actor"`
		Wanted []string       `json:"wanted"`
	}) (any, error) {
		return PlanPathChange(in.Project, in.Item, in.Actor, in.Wanted)
	}),
	"isUnshaped": pure(func(in struct {
		Item model.Item `json:"item"`
	}) (any, error) {
		return IsUnshaped(in.Item), nil
	}),
	"pathOf": pure(func(in projItem) (any, error) { return PathOf(in.Project, in.Item), nil }),
	"stepsOnPath": pure(func(in projItem) (any, error) {
		out := []any{}
		for _, p := range StepsOnPath(in.Project, in.Item) {
			m := map[string]any{"step": p.Step.ID, "state": p.State}
			if p.Request != "" {
				m["request"] = p.Request
			}
			if p.Note != "" {
				m["note"] = p.Note
			}
			out = append(out, m)
		}
		return out, nil
	}),
	"nextOnPath": pure(func(in struct {
		projItem
		StepID *string `json:"stepId"`
	}) (any, error) {
		from := in.Item.StepID
		if in.StepID != nil {
			from = *in.StepID
		}
		return stepID(NextOnPath(in.Project, in.Item, from)), nil
	}),
	"firstOnPath": pure(func(in projItem) (any, error) { return stepID(FirstOnPath(in.Project, in.Item)), nil }),
	"isOnHold": pure(func(in struct {
		Item model.Item `json:"item"`
	}) (any, error) {
		return IsOnHold(in.Item), nil
	}),
	"guardrailsOf": pure(func(in struct {
		Agent model.Agent `json:"agent"`
	}) (any, error) {
		return GuardrailsOf(in.Agent), nil
	}),
	"isPaused": pure(func(in struct {
		Agent model.Agent `json:"agent"`
	}) (any, error) {
		return IsPaused(in.Agent), nil
	}),
	"agentMayTakeStep": pure(func(in struct {
		Project  model.Project `json:"project"`
		StepID   string        `json:"stepId"`
		AgentUID string        `json:"agentUid"`
	}) (any, error) {
		return AgentMayTakeStep(in.Project, in.StepID, in.AgentUID), nil
	}),
	"allowedAgentsFor": pure(func(in struct {
		Project model.Project `json:"project"`
		StepID  string        `json:"stepId"`
	}) (any, error) {
		return AllowedAgentsFor(in.Project, in.StepID), nil
	}),
	"newTokens": pure(func(in TokenUsage) (any, error) { return NewTokens(in), nil }),
	"streakAfter": pure(func(in struct {
		Agent  model.Agent `json:"agent"`
		Status string      `json:"status"`
	}) (any, error) {
		return StreakAfter(in.Agent, in.Status), nil
	}),
	"liveTerminal": pure(func(in struct {
		Agent model.Agent `json:"agent"`
		Now   int64       `json:"now"`
	}) (any, error) {
		t := LiveTerminal(in.Agent, in.Now)
		if t == nil {
			return nil, nil
		}
		return map[string]any{"host": t.Host, "since": t.Since}, nil
	}),
}

// timestampsToRFC3339 turns {"__hive":"timestamp","ms":n} into RFC 3339 strings (what
// encoding/json reads into time.Time).
func timestampsToRFC3339(v any) any {
	switch x := v.(type) {
	case map[string]any:
		if x["__hive"] == "timestamp" {
			ms, _ := x["ms"].(json.Number).Int64()
			return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
		}
		for k, e := range x {
			x[k] = timestampsToRFC3339(e)
		}
	case []any:
		for i, e := range x {
			x[i] = timestampsToRFC3339(e)
		}
	}
	return v
}

// timesToPlaceholders turns time.Time values in a Go output into timestamp placeholders.
func timesToPlaceholders(v any) any {
	switch x := v.(type) {
	case time.Time:
		return map[string]any{"__hive": "timestamp", "ms": x.UnixMilli()}
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = timesToPlaceholders(e)
		}
		return out
	}
	return v
}

func generic(b []byte) (any, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	err := d.Decode(&v)
	return v, err
}

// normalize compares numbers by value (int vs float spelling does not matter).
func normalize(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, _ := x.Float64()
		return f
	case map[string]any:
		for k, e := range x {
			x[k] = normalize(e)
		}
	case []any:
		for i, e := range x {
			x[i] = normalize(e)
		}
	}
	return v
}

func loadContract(t *testing.T) contractFile {
	t.Helper()
	b, err := os.ReadFile("testdata/contract.json")
	if err != nil {
		t.Fatalf("read fixture: %v (generate it: UPDATE_GO_CONTRACT=1 pnpm test:scripts)", err)
	}
	var f contractFile
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("no contract cases")
	}
	return f
}

func runCase(f contractFile, c contractCase) (any, error) {
	r, ok := runners[c.Action]
	if !ok {
		return nil, fmt.Errorf("no Go runner for action %q", c.Action)
	}
	in, err := generic(c.Input)
	if err != nil {
		return nil, err
	}
	input, err := json.Marshal(timestampsToRFC3339(in))
	if err != nil {
		return nil, err
	}
	var ctx Ctx
	if c.Ctx != nil {
		ctx = *c.Ctx
	}
	n := 0
	ctx.NewID = func() string { n++; return fmt.Sprintf("id%02d", n) }
	ctx.Now = func() time.Time { return time.UnixMilli(f.NowMs) }
	out, err := r(ctx, input)
	var ae *Error
	if errors.As(err, &ae) {
		return map[string]any{"error": ae.Msg}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("runner failed: %w", err)
	}
	b, err := json.Marshal(timesToPlaceholders(out))
	if err != nil {
		return nil, err
	}
	return generic(b)
}

func TestContract(t *testing.T) {
	f := loadContract(t)
	used := map[string]bool{}
	for _, c := range f.Cases {
		used[c.Action] = true
		t.Run(c.Name, func(t *testing.T) {
			got, err := runCase(f, c)
			if err != nil {
				t.Fatal(err)
			}
			want, err := generic(c.Output)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(normalize(got), normalize(want)) {
				g, _ := json.MarshalIndent(got, "", "  ")
				w, _ := json.MarshalIndent(want, "", "  ")
				t.Errorf("Go output differs from TypeScript\n--- Go:\n%s\n--- TypeScript:\n%s", g, w)
			}
		})
	}
	var unused []string
	for a := range runners {
		if !used[a] {
			unused = append(unused, a)
		}
	}
	sort.Strings(unused)
	if len(unused) > 0 {
		t.Errorf("Go runners without a contract case (add one to cli/contract/cases.ts): %v", unused)
	}
}

// The ops of a plan must be committable: every placeholder converts to a Firestore value.
func TestContractPlansConvert(t *testing.T) {
	f := loadContract(t)
	for _, c := range f.Cases {
		var out struct {
			Ops  []plan.Op `json:"ops"`
			Asks []struct {
				Ops []plan.Op `json:"ops"`
			} `json:"asks"`
		}
		if err := json.Unmarshal(c.Output, &out); err != nil {
			continue // not a plan
		}
		ops := out.Ops
		for _, a := range out.Asks {
			ops = append(ops, a.Ops...)
		}
		for _, op := range ops {
			if _, err := plan.Value(op.Data); err != nil {
				t.Errorf("%s: %s: %v", c.Name, op.Path, err)
			}
		}
	}
}
