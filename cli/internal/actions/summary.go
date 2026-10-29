package actions

// Thread summaries (item OE8FmrTaIxFVGcaeGG3N): the Go port of packages/shared/src/summary.ts
// (checkSummary and writeSummary). The contract cases (cli/contract/cases.ts) hold both to the
// same output and the same plain errors.

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// SUMMARY_LIMITS.
const (
	SumHeadline     = 120
	SumAsk          = 200
	SumAnswer       = 160
	SumRecAction    = 40
	SumRecWhy       = 200
	SumBullets      = 5
	SumBullet       = 160
	SumBulletRefs   = 3
	SumDetails      = 6000
	SumVisuals      = 4
	SumNoVisualWhy  = 140
	SumRefs         = 30
	SumRefID        = 64
	SumRefLabel     = 60
	SumURL          = 2048
	SumBasisEventID = 128
	SumTitle        = 80
	SumCaption      = 200
	SumUnit         = 12
	SumMinPoints    = 2
	SumPoints       = 24
	SumXLabel       = 16
	SumSeries       = 4
	SumSeriesName   = 30
	SumMaxAbs       = 1e12
	SumMinNodes     = 2
	SumNodes        = 8
	SumNodeID       = 16
	SumNodeLabel    = 40
	SumEdges        = 10
	SumEdgeLabel    = 24
	SumSideLabel    = 24
	SumLines        = 6
	SumLine         = 60
	SumMinEvents    = 2
	SumEvents       = 12
	SumEventLabel   = 60
	SumVersionsKept = 20
)

var (
	chartKinds   = []string{"bar", "line", "stacked_bar"}
	visualKinds  = []string{"bar", "line", "stacked_bar", "number", "flow", "before_after", "timeline"}
	refKinds     = []string{"message", "attachment", "step", "event", "link"}
	betterValues = []string{"up", "down"}
	nodeWho      = []string{"agent", "person", "system"}
	nodeStates   = []string{"done", "now", "next", "changed", "removed"}
	eventStates  = []string{"done", "now", "next", "risk"}
	confidences  = []string{"high", "medium", "low"}
	visualKeys   = map[string][]string{
		"bar":          {"kind", "title", "caption", "unit", "x", "series", "highlight", "better"},
		"line":         {"kind", "title", "caption", "unit", "x", "series", "highlight", "better"},
		"stacked_bar":  {"kind", "title", "caption", "unit", "x", "series", "highlight", "better"},
		"number":       {"kind", "title", "caption", "value", "unit", "delta", "trend", "better"},
		"flow":         {"kind", "title", "caption", "nodes", "edges"},
		"before_after": {"kind", "title", "caption", "before", "after"},
		"timeline":     {"kind", "title", "caption", "events"},
	}
	summaryInputKeys = []string{"headline", "ask", "answer", "recommendation", "confidence", "bullets", "details", "visuals", "noVisualWhy", "refs"}
	tagRe            = regexp.MustCompile(`<[a-zA-Z/!]`)
	isoDateRe        = regexp.MustCompile(`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,3})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)?)?$`)
	httpsRe          = regexp.MustCompile(`^https://\S+$`)
)

// sumFail stops checkSummary with a plain error.
type sumFail struct{ msg string }

func sfail(msg string) { panic(sumFail{msg}) }

func absentV(v any) bool { return v == nil }

func sobj(where string, v any, keys []string) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		sfail(where + ": an object")
	}
	var extra []string
	for k := range m {
		if !inList(k, keys...) {
			extra = append(extra, k)
		}
	}
	if len(extra) > 0 {
		sort.Strings(extra)
		sfail(where + `: unknown field "` + extra[0] + `"`)
	}
	return m
}

func slist(where string, v any) []any {
	l, ok := v.([]any)
	if !ok {
		sfail(where + ": a list")
	}
	return l
}

// stext is text(): trimmed, 1..max; nil when optional and absent or empty.
func stext(where string, v any, max int, required, plainOnly bool) any {
	if absentV(v) {
		if required {
			sfail(where + ": required")
		}
		return nil
	}
	s, ok := v.(string)
	if !ok {
		sfail(where + ": a text")
	}
	t := jsTrim(s)
	if t == "" {
		if required {
			sfail(where + ": required")
		}
		return nil
	}
	if jsLen(t) > max {
		sfail(where + ": at most " + strconv.Itoa(max) + " characters")
	}
	if plainOnly && tagRe.MatchString(t) {
		sfail(where + ": plain text only (no HTML)")
	}
	return t
}

func sneed(where string, v any, max int, plainOnly bool) string {
	return stext(where, v, max, true, plainOnly).(string)
}

func sopt(where string, v any, max int, plainOnly bool) any {
	return stext(where, v, max, false, plainOnly)
}

func soneOf(where string, v any, all []string) any {
	if absentV(v) {
		return nil
	}
	s, ok := v.(string)
	if !ok || !inList(s, all...) {
		sfail(where + ": one of " + strings.Join(all, ", "))
	}
	return s
}

// toFloat reads a JSON number (float64 from encoding/json; ints and json.Number too).
func toFloat(v any) (float64, bool) {
	switch x := v.(type) {
	case float64:
		return x, true
	case float32:
		return float64(x), true
	case int:
		return float64(x), true
	case int64:
		return float64(x), true
	case json.Number:
		f, err := x.Float64()
		return f, err == nil
	}
	return 0, false
}

// jsNumber is how the JS SDK writes a number: a safe integer as an integer, else a double.
func jsNumber(f float64) any {
	if f == math.Trunc(f) && math.Abs(f) <= 1<<53 && !(f == 0 && math.Signbit(f)) {
		return int64(f)
	}
	return f
}

func snumber(where string, v any, required bool) any {
	if absentV(v) {
		if required {
			sfail(where + ": required")
		}
		return nil
	}
	f, ok := toFloat(v)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || math.Abs(f) > SumMaxAbs {
		sfail(where + ": a number, at most 1000000000000 either way")
	}
	return jsNumber(f)
}

func scount(where string, n, min, max int, unit string) {
	if n < min {
		sfail(where + ": " + strconv.Itoa(n) + " " + unit + ", at least " + strconv.Itoa(min))
	}
	if n > max {
		sfail(where + ": " + strconv.Itoa(n) + " " + unit + ", at most " + strconv.Itoa(max))
	}
}

func sref(where string, v any) map[string]any {
	r := sobj(where, v, []string{"kind", "id", "label", "url"})
	kind := soneOf(where+" kind", r["kind"], refKinds)
	if kind == nil {
		sfail(where + " kind: required")
	}
	id := sneed(where+" id", r["id"], SumRefID, false)
	label := sneed(where+" label", r["label"], SumRefLabel, false)
	url := sopt(where+" url", r["url"], SumURL, false)
	if u, ok := url.(string); ok && !httpsRe.MatchString(u) {
		sfail(where + " url: an https link")
	}
	if kind == "link" && url == nil {
		sfail(where + " url: required for a link")
	}
	return map[string]any{"kind": kind, "id": id, "label": label, "url": url}
}

func schart(where string, v map[string]any, kind string) map[string]any {
	x := slist(where+" x", v["x"])
	scount(where, len(x), SumMinPoints, SumPoints, "points")
	xs := make([]any, len(x))
	for i, e := range x {
		xs[i] = sneed(where+" x "+strconv.Itoa(i+1), e, SumXLabel, true)
	}
	series := slist(where+" series", v["series"])
	minSeries := 1
	if kind == "stacked_bar" {
		minSeries = 2
	}
	scount(where, len(series), minSeries, SumSeries, "series")
	ss := make([]any, len(series))
	for i, e := range series {
		w := where + " series " + strconv.Itoa(i+1)
		s := sobj(w, e, []string{"name", "values"})
		name := sneed(w+" name", s["name"], SumSeriesName, true)
		values := slist(w+" values", s["values"])
		if len(values) != len(xs) {
			sfail(w + ": " + strconv.Itoa(len(values)) + " values for " + strconv.Itoa(len(xs)) + " points")
		}
		vs := make([]any, len(values))
		for j, n := range values {
			vs[j] = snumber(w+" value "+strconv.Itoa(j+1), n, false)
		}
		ss[i] = map[string]any{"name": name, "values": vs}
	}
	var highlight any
	if !absentV(v["highlight"]) {
		h, ok := toFloat(v["highlight"])
		if !ok || h != math.Trunc(h) || h < 0 || h >= float64(len(xs)) {
			sfail(where + " highlight: an index of x, 0 to " + strconv.Itoa(len(xs)-1))
		}
		highlight = int64(h)
	}
	return map[string]any{
		"kind": kind, "unit": sopt(where+" unit", v["unit"], SumUnit, true), "x": xs, "series": ss,
		"highlight": highlight, "better": soneOf(where+" better", v["better"], betterValues),
	}
}

func svisual(where string, raw any) map[string]any {
	rm, ok := raw.(map[string]any)
	if !ok {
		sfail(where + ": an object")
	}
	kindV := soneOf(where+" kind", rm["kind"], visualKinds)
	if kindV == nil {
		sfail(where + " kind: required")
	}
	kind := kindV.(string)
	v := sobj(where, rm, visualKeys[kind])
	title := sneed(where+" title", v["title"], SumTitle, true)
	caption := sneed(where+" caption", v["caption"], SumCaption, true)
	out := map[string]any{"kind": kind, "title": title, "caption": caption}
	switch kind {
	case "bar", "line", "stacked_bar":
		for k, e := range schart(where, v, kind) {
			out[k] = e
		}
	case "number":
		out["value"] = snumber(where+" value", v["value"], true)
		out["unit"] = sopt(where+" unit", v["unit"], SumUnit, true)
		out["delta"] = snumber(where+" delta", v["delta"], false)
		var trend any
		if !absentV(v["trend"]) {
			t := slist(where+" trend", v["trend"])
			scount(where+" trend", len(t), SumMinPoints, SumPoints, "points")
			ts := make([]any, len(t))
			for i, n := range t {
				ts[i] = snumber(where+" trend "+strconv.Itoa(i+1), n, true)
			}
			trend = ts
		}
		out["trend"] = trend
		out["better"] = soneOf(where+" better", v["better"], betterValues)
	case "flow":
		nodes := slist(where+" nodes", v["nodes"])
		scount(where, len(nodes), SumMinNodes, SumNodes, "nodes")
		seen := map[string]bool{}
		ns := make([]any, len(nodes))
		for i, e := range nodes {
			w := where + " node " + strconv.Itoa(i+1)
			n := sobj(w, e, []string{"id", "label", "who", "state"})
			id := sneed(w+" id", n["id"], SumNodeID, true)
			if seen[id] {
				sfail(w + ` id: "` + id + `" is used twice`)
			}
			seen[id] = true
			ns[i] = map[string]any{
				"id": id, "label": sneed(w+" label", n["label"], SumNodeLabel, true),
				"who": soneOf(w+" who", n["who"], nodeWho), "state": soneOf(w+" state", n["state"], nodeStates),
			}
		}
		var edges []any
		if !absentV(v["edges"]) {
			edges = slist(where+" edges", v["edges"])
		}
		if len(edges) > SumEdges {
			sfail(where + ": " + strconv.Itoa(len(edges)) + " edges, at most " + strconv.Itoa(SumEdges))
		}
		es := make([]any, len(edges))
		for i, e := range edges {
			w := where + " edge " + strconv.Itoa(i+1)
			d := sobj(w, e, []string{"from", "to", "label"})
			from := sneed(w+" from", d["from"], SumNodeID, true)
			if !seen[from] {
				sfail(w + ` from: no node "` + from + `"`)
			}
			to := sneed(w+" to", d["to"], SumNodeID, true)
			if !seen[to] {
				sfail(w + ` to: no node "` + to + `"`)
			}
			es[i] = map[string]any{"from": from, "to": to, "label": sopt(w+" label", d["label"], SumEdgeLabel, true)}
		}
		out["nodes"], out["edges"] = ns, es
	case "before_after":
		side := func(name string) map[string]any {
			w := where + " " + name
			s := sobj(w, v[name], []string{"label", "lines"})
			lines := slist(w+" lines", s["lines"])
			scount(w, len(lines), 1, SumLines, "lines")
			label := sopt(w+" label", s["label"], SumSideLabel, true)
			ls := make([]any, len(lines))
			for i, l := range lines {
				ls[i] = sneed(w+" line "+strconv.Itoa(i+1), l, SumLine, true)
			}
			return map[string]any{"label": label, "lines": ls}
		}
		out["before"] = side("before")
		out["after"] = side("after")
	case "timeline":
		events := slist(where+" events", v["events"])
		scount(where, len(events), SumMinEvents, SumEvents, "events")
		es := make([]any, len(events))
		for i, e := range events {
			w := where + " event " + strconv.Itoa(i+1)
			d := sobj(w, e, []string{"at", "label", "state"})
			at := sneed(w+" at", d["at"], 40, false)
			if !isoDateRe.MatchString(at) {
				sfail(w + " at: an ISO date (2026-10-29) or date and time (2026-10-29T14:00Z)")
			}
			es[i] = map[string]any{"at": at, "label": sneed(w+" label", d["label"], SumEventLabel, true), "state": soneOf(w+" state", d["state"], eventStates)}
		}
		out["events"] = es
	}
	return out
}

// CheckSummary is checkSummary: what an agent gives, checked and cleaned (texts trimmed, every
// stored key present, nil when not given), or a plain error.
func CheckSummary(input any) (out map[string]any, err error) {
	defer func() {
		if r := recover(); r != nil {
			f, ok := r.(sumFail)
			if !ok {
				panic(r)
			}
			out, err = nil, fail(f.msg)
		}
	}()
	s := sobj("summary", input, summaryInputKeys)
	headline := sneed("headline", s["headline"], SumHeadline, false)
	ask := sopt("ask", s["ask"], SumAsk, false)
	answer := sopt("answer", s["answer"], SumAnswer, false)
	var rec any
	if !absentV(s["recommendation"]) {
		r := sobj("recommendation", s["recommendation"], []string{"action", "why"})
		rec = map[string]any{
			"action": sneed("recommendation action", r["action"], SumRecAction, false),
			"why":    sneed("recommendation why", r["why"], SumRecWhy, false),
		}
	}
	confidence := soneOf("confidence", s["confidence"], confidences)
	if absentV(s["bullets"]) {
		sfail("bullets: required (1 to 5)")
	}
	bl := slist("bullets", s["bullets"])
	scount("bullets", len(bl), 1, SumBullets, "bullets")
	bullets := make([]any, len(bl))
	for i, e := range bl {
		w := "bullet " + strconv.Itoa(i+1)
		var b map[string]any
		if t, ok := e.(string); ok {
			b = map[string]any{"text": t}
		} else {
			b = sobj(w, e, []string{"text", "refs"})
		}
		var refs []any
		if !absentV(b["refs"]) {
			refs = slist(w+" refs", b["refs"])
		}
		if len(refs) > SumBulletRefs {
			sfail(w + ": " + strconv.Itoa(len(refs)) + " refs, at most " + strconv.Itoa(SumBulletRefs))
		}
		text := sneed(w+" text", b["text"], SumBullet, false)
		rs := make([]any, len(refs))
		for j, r := range refs {
			rs[j] = sref(w+" ref "+strconv.Itoa(j+1), r)
		}
		bullets[i] = map[string]any{"text": text, "refs": rs}
	}
	details := sopt("details", s["details"], SumDetails, false)
	var vl []any
	if !absentV(s["visuals"]) {
		vl = slist("visuals", s["visuals"])
	}
	if len(vl) > SumVisuals {
		sfail("visuals: " + strconv.Itoa(len(vl)) + " visuals, at most " + strconv.Itoa(SumVisuals))
	}
	visuals := make([]any, len(vl))
	for i, v := range vl {
		visuals[i] = svisual("visual "+strconv.Itoa(i+1), v)
	}
	noVisualWhy := sopt("noVisualWhy", s["noVisualWhy"], SumNoVisualWhy, false)
	var rl []any
	if !absentV(s["refs"]) {
		rl = slist("refs", s["refs"])
	}
	if len(rl) > SumRefs {
		sfail("refs: " + strconv.Itoa(len(rl)) + " refs, at most " + strconv.Itoa(SumRefs))
	}
	refs := make([]any, len(rl))
	for i, r := range rl {
		refs[i] = sref("ref "+strconv.Itoa(i+1), r)
	}
	if ask != nil && len(visuals) == 0 && noVisualWhy == nil {
		sfail("At a person step add a visual or say why there is none: a chart for data, before/after or a flow for a change, or noVisualWhy in one line.")
	}
	return map[string]any{
		"headline": headline, "ask": ask, "answer": answer, "recommendation": rec, "confidence": confidence,
		"bullets": bullets, "details": details, "visuals": visuals, "noVisualWhy": noVisualWhy, "refs": refs,
	}, nil
}

// SummaryBasis is what the agent had read (the thread's last event, its live plan's cursor).
type SummaryBasis struct {
	LastEventID *string `json:"lastEventId"`
	PlanCursor  *int    `json:"planCursor"`
}

// SummaryCurrent is the current summary's version (nil: none yet).
type SummaryCurrent struct {
	Version int `json:"version"`
}

// WriteSummaryInput is writeSummary's input (thread_summary).
type WriteSummaryInput struct {
	ThreadID    string          `json:"threadId"`
	Thread      ThreadState     `json:"thread"`
	Current     *SummaryCurrent `json:"current"`
	BaseVersion *float64        `json:"baseVersion"`
	Summary     any             `json:"summary"`
	Basis       *SummaryBasis   `json:"basis"`
}

// WriteSummaryResult is the plan plus the version written.
type WriteSummaryResult struct {
	EventID string    `json:"eventId"`
	Ops     []plan.Op `json:"ops"`
	Version int       `json:"version"`
}

// Plan is the batch to commit.
func (r WriteSummaryResult) Plan() plan.Plan { return plan.Plan{EventID: r.EventID, Ops: r.Ops} }

// SummaryPath and SummaryVersionPath are summaryPaths.
func SummaryPath(w, t string) string { return "workspaces/" + w + "/inboxSummaries/" + t }
func SummaryVersionPath(w, t string, v int) string {
	return "workspaces/" + w + "/inboxSummaryVersions/" + t + "_" + strconv.Itoa(v)
}

// WriteSummary is writeSummary: the home agent writes the thread's summary (version + 1): the
// summary doc, its version doc (the one 20 back deleted), the thread's mirror, one event.
func WriteSummary(ctx Ctx, in WriteSummaryInput) (WriteSummaryResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return WriteSummaryResult{}, err
	}
	t := in.Thread
	if t.FetchedBy != ctx.Actor.ID {
		return WriteSummaryResult{}, fail("Only the thread's home agent (the one that brought it in) writes its summary.")
	}
	cur := 0
	if in.Current != nil {
		cur = in.Current.Version
	}
	if in.BaseVersion == nil || *in.BaseVersion != math.Trunc(*in.BaseVersion) || *in.BaseVersion < 0 {
		return WriteSummaryResult{}, fail("baseVersion: the summary version you read (thread_read), 0 when there is none.")
	}
	if int(*in.BaseVersion) != cur {
		if cur == 0 {
			return WriteSummaryResult{}, fail("This thread has no summary yet: write it with baseVersion 0.")
		}
		c := strconv.Itoa(cur)
		return WriteSummaryResult{}, fail("The summary moved on to v" + c + ": re-read the thread (thread_read), then write it with baseVersion " + c + ".")
	}
	content, err := CheckSummary(in.Summary)
	if err != nil {
		return WriteSummaryResult{}, err
	}
	var lastEv, cursor any
	if in.Basis != nil {
		if in.Basis.LastEventID != nil {
			if jsLen(*in.Basis.LastEventID) > SumBasisEventID {
				return WriteSummaryResult{}, fail("basis lastEventId: at most " + strconv.Itoa(SumBasisEventID) + " characters")
			}
			lastEv = *in.Basis.LastEventID
		}
		if in.Basis.PlanCursor != nil {
			if *in.Basis.PlanCursor < 0 {
				return WriteSummaryResult{}, fail("basis planCursor: a step index")
			}
			cursor = int64(*in.Basis.PlanCursor)
		}
	}
	version := cur + 1
	w := ctx.WorkspaceID
	p := InboxPlan(ctx, "summary.written", t.MemberUID, sp(in.ThreadID), t.SubjectID, map[string]any{"version": version},
		func(eventID string) []plan.Op {
			doc := func() map[string]any {
				d := map[string]any{
					"memberUid": t.MemberUID, "threadId": in.ThreadID, "version": version, "by": ctx.Actor.ID,
					"at": ServerTime(), "basis": map[string]any{"lastEventId": lastEv, "planCursor": cursor}, "lastEventId": eventID,
				}
				for k, v := range content {
					d[k] = v
				}
				return d
			}
			ops := []plan.Op{
				{Kind: "set", Path: SummaryPath(w, in.ThreadID), Data: doc()},
				{Kind: "set", Path: SummaryVersionPath(w, in.ThreadID, version), Data: doc()},
			}
			if version > SumVersionsKept {
				ops = append(ops, plan.Op{Kind: "delete", Path: SummaryVersionPath(w, in.ThreadID, version-SumVersionsKept)})
			}
			var recAction any
			if r, ok := content["recommendation"].(map[string]any); ok {
				recAction = r["action"]
			}
			ops = append(ops, plan.Op{Kind: "update", Path: model.Paths.InboxThread(w, in.ThreadID), Data: map[string]any{
				"summary": map[string]any{
					"version": version, "at": ServerTime(), "headline": content["headline"], "ask": content["ask"],
					"answer": content["answer"], "recAction": recAction, "confidence": content["confidence"],
				},
				"updatedAt": ServerTime(), "lastEventId": eventID,
			}})
			return ops
		}, "")
	return WriteSummaryResult{EventID: p.EventID, Ops: p.Ops, Version: version}, nil
}
