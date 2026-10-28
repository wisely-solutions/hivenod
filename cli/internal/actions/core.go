// Package actions builds the same Firestore write plans as the TypeScript shared actions the agent
// uses (packages/shared/src/actions.ts, pathActions.ts, sendback.ts, itempath.ts, agents.ts,
// stopwork.ts): one batch = the domain change + exactly one event doc. TypeScript stays the source
// of truth: testdata/contract.json is generated from it (cli/contract/cases.ts) and
// contract_test.go proves these functions give the same output for every case.
//
// Plans use the placeholder form of package plan ({"__hive":"serverTime"}, …). Integers are
// int64 and other numbers float64, as the JS SDK writes them.
package actions

import (
	"crypto/rand"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf16"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Actor is who acts: Type "human" or "agent".
type Actor struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Ctx is the TS ActionContext plus a clock (for the places TS reads Date.now()).
type Ctx struct {
	WorkspaceID string `json:"workspaceId"`
	Actor       Actor  `json:"actor"`
	// Via is set when the action did not come from the app ("telegram"); only decision.* events carry it.
	Via string `json:"via,omitempty"`
	// NewID defaults to RandomID.
	NewID func() string `json:"-"`
	// Now defaults to time.Now.
	Now func() time.Time `json:"-"`
}

func (c Ctx) nid() string {
	if c.NewID != nil {
		return c.NewID()
	}
	return RandomID(20)
}

func (c Ctx) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// Error is the TS ActionError: a refusal with a message for the user.
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

func fail(msg string) error { return &Error{Msg: msg} }

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

// RandomID is n random base62 characters (crypto/rand; same byte%62 mapping as the TS randomId).
func RandomID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// ---------- placeholders ----------

// ServerTime is the serverTimestamp() placeholder.
func ServerTime() map[string]any { return map[string]any{"__hive": "serverTime"} }

// DeleteField is the deleteField() placeholder.
func DeleteField() map[string]any { return map[string]any{"__hive": "deleteField"} }

// ArrayUnion is the arrayUnion(...values) placeholder.
func ArrayUnion(values ...string) map[string]any {
	vs := make([]any, len(values))
	for i, v := range values {
		vs[i] = v
	}
	return map[string]any{"__hive": "arrayUnion", "values": vs}
}

// Increment is the increment(n) placeholder.
func Increment(by float64) map[string]any {
	return map[string]any{"__hive": "increment", "by": Num(by)}
}

// Num is a JS number as the JS SDK writes it: int64 when it is a safe integer, else float64.
func Num(f float64) any {
	if f == math.Trunc(f) && math.Abs(f) <= 1<<53-1 && !(f == 0 && math.Signbit(f)) {
		return int64(f)
	}
	return f
}

// ---------- plan ----------

// Scope of an event; nil fields are null.
type Scope struct {
	ProjectID *string
	ItemID    *string
	RunID     *string
}

func sp(s string) *string { return &s }

// Plan wraps a domain change with its event: the ops build returns, then the event doc. eventID
// is generated when empty.
func Plan(ctx Ctx, typ string, scope Scope, data map[string]any, build func(eventID string) []plan.Op, eventID string) plan.Plan {
	if eventID == "" {
		eventID = ctx.nid()
	}
	evData := data
	if ctx.Via != "" && strings.HasPrefix(typ, "decision.") {
		evData = make(map[string]any, len(data)+1)
		for k, v := range data {
			evData[k] = v
		}
		evData["via"] = ctx.Via
	}
	ptr := func(p *string) any {
		if p == nil {
			return nil
		}
		return *p
	}
	event := plan.Op{
		Kind: "set",
		Path: model.Paths.Event(ctx.WorkspaceID, eventID),
		Data: map[string]any{
			"actor":     map[string]any{"type": ctx.Actor.Type, "id": ctx.Actor.ID, "name": ctx.Actor.Name},
			"projectId": ptr(scope.ProjectID),
			"itemId":    ptr(scope.ItemID),
			"runId":     ptr(scope.RunID),
			"type":      typ,
			"data":      evData,
			"at":        ServerTime(),
		},
	}
	return plan.Plan{EventID: eventID, Ops: append(build(eventID), event)}
}

// RequireHuman refuses agents.
func RequireHuman(ctx Ctx) error {
	if ctx.Actor.Type != "human" {
		return fail("Only people can do this")
	}
	return nil
}

// RequireAgent refuses people.
func RequireAgent(ctx Ctx) error {
	if ctx.Actor.Type != "agent" {
		return fail("Only agents can do this")
	}
	return nil
}

// RequireReason wants at least MinReasonChars after trimming.
func RequireReason(text string) error {
	if jsLen(jsTrim(text)) < model.MinReasonChars {
		return fail("Say why in at least " + strconv.Itoa(model.MinReasonChars) + " characters")
	}
	return nil
}

// StepIndexOf is the step's position in the library.
func StepIndexOf(project model.Project, stepID string) (int, error) {
	for i, s := range project.Steps {
		if s.ID == stepID {
			return i, nil
		}
	}
	return -1, fail("Unknown step " + stepID)
}

func stepOf(project model.Project, stepID string) (model.Step, error) {
	i, err := StepIndexOf(project, stepID)
	if err != nil {
		return model.Step{}, err
	}
	return project.Steps[i], nil
}

// Arrival is the fields that put an item at step (a fresh gate for people steps). stepAt is when it
// got there (item QjTTL): claimable work is handed out oldest first by it.
func Arrival(step model.Step) map[string]any {
	if step.Kind == "human" {
		return map[string]any{
			"stepId": step.ID,
			"status": "waiting",
			"claim":  nil,
			"gate":   map[string]any{"stepId": step.ID, "approvals": map[string]any{}, "rejections": map[string]any{}},
			"stepAt": ServerTime(),
		}
	}
	return map[string]any{"stepId": step.ID, "status": "queued", "claim": nil, "gate": nil, "stepAt": ServerTime()}
}

// Forward is one step on along the path, or done after the last one.
func Forward(project model.Project, item model.Item) map[string]any {
	if next := NextOnPath(project, item, item.StepID); next != nil {
		return Arrival(*next)
	}
	return map[string]any{"stepId": item.StepID, "status": "done", "claim": nil, "gate": nil}
}

// OwnClaim is the actor's claim on the item, or an error.
func OwnClaim(ctx Ctx, item model.Item) (model.Claim, error) {
	if item.Claim == nil || item.Claim.AgentUID != ctx.Actor.ID {
		return model.Claim{}, fail("You do not hold this item")
	}
	return *item.Claim, nil
}

// merge copies maps left to right into a new one (like {...a, ...b}).
func merge(ms ...map[string]any) map[string]any {
	out := map[string]any{}
	for _, m := range ms {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

// ---------- JS string semantics ----------

// jsLen is String.prototype.length (UTF-16 code units).
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

// jsSlice is s.slice(0, n) in UTF-16 code units. A cut through a surrogate pair drops the pair's
// half (JS would keep a lone surrogate, which Go strings cannot hold).
func jsSlice(s string, n int) string {
	units := 0
	for i, r := range s {
		u := utf16.RuneLen(r)
		if units+u > n {
			return s[:i]
		}
		units += u
	}
	return s
}

// jsSpace is the WhiteSpace and LineTerminator set String.prototype.trim strips.
func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xA0, 0xFEFF, 0x2028, 0x2029:
		return true
	}
	return unicode.Is(unicode.Zs, r)
}

// JSTrim is String.prototype.trim (exported for the hive package).
func JSTrim(s string) string { return jsTrim(s) }

// jsTrim is String.prototype.trim.
func jsTrim(s string) string { return strings.TrimFunc(s, jsSpace) }

// jsKeys orders keys (given in insertion order) like Object.keys: array-index keys first in
// ascending numeric order, then the rest in insertion order.
func jsKeys(keys []string) []string {
	var idx []uint64
	var rest []string
	for _, k := range keys {
		if n, err := strconv.ParseUint(k, 10, 32); err == nil && strconv.FormatUint(n, 10) == k && n < 1<<32-1 {
			idx = append(idx, n)
		} else {
			rest = append(rest, k)
		}
	}
	for i := 1; i < len(idx); i++ {
		for j := i; j > 0 && idx[j] < idx[j-1]; j-- {
			idx[j], idx[j-1] = idx[j-1], idx[j]
		}
	}
	out := make([]string, 0, len(keys))
	for _, n := range idx {
		out = append(out, strconv.FormatUint(n, 10))
	}
	return append(out, rest...)
}

// jsRound is Math.round (halves round up, towards +Infinity).
func jsRound(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return x
	}
	f := math.Floor(x)
	if x-f >= 0.5 {
		f++
	}
	return f
}

func strs(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}

// JSSlice is s.slice(0, n) in UTF-16 code units (exported for the hive package).
func JSSlice(s string, n int) string { return jsSlice(s, n) }

// JSSpace is the whitespace set of String.prototype.trim and /\s/ (exported for the hive package).
func JSSpace(r rune) bool { return jsSpace(r) }
