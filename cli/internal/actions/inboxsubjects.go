package actions

// Related subjects and subject search (item 4PEHrOW5IfXBQWgOK9wo): proposeRelation, relationId
// and searchSubjects of packages/shared/src/inbox.ts. The member's relation actions (relate,
// turn down, remove) are web-only and stay in TypeScript.

import (
	"math"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// InboxMaxRelationNote is INBOX_LIMITS.relationNote.
const InboxMaxRelationNote = 500

// RelationID is relationId: the one document id of a pair, either way round.
func RelationID(a, b string) string {
	if jsLess(b, a) {
		a, b = b, a
	}
	return "rel-" + a + "-" + b
}

// jsLess is a < b on JavaScript strings (UTF-16 code units).
func jsLess(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}

func jsCmp(a, b string) int {
	switch {
	case a == b:
		return 0
	case jsLess(a, b):
		return -1
	}
	return 1
}

// SubjectOf is what a relation needs of a subject.
type SubjectOf struct {
	MemberUID string `json:"memberUid"`
}

// RelationState is RelationStateOf.
type RelationState struct {
	MemberUID string `json:"memberUid"`
	A         string `json:"a"`
	B         string `json:"b"`
	Note      string `json:"note"`
	State     string `json:"state"`
}

// ProposeRelationInput is the input of proposeRelation.
type ProposeRelationInput struct {
	A        string         `json:"a"`
	B        string         `json:"b"`
	SubjectA SubjectOf      `json:"subjectA"`
	SubjectB SubjectOf      `json:"subjectB"`
	Existing *RelationState `json:"existing"`
	Note     *string        `json:"note"`
}

// RelationResult is proposeRelation's plan plus the pair.
type RelationResult struct {
	plan.Plan
	RelationID string `json:"relationId"`
	A          string `json:"a"`
	B          string `json:"b"`
}

// ProposeRelation is proposeRelation: an agent proposes that two subjects are related.
func ProposeRelation(ctx Ctx, in ProposeRelationInput) (RelationResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return RelationResult{}, err
	}
	if err := need(in.A != in.B, "Pick two different subjects."); err != nil {
		return RelationResult{}, err
	}
	if err := need(in.SubjectA.MemberUID == in.SubjectB.MemberUID, "Both subjects must be for the same person."); err != nil {
		return RelationResult{}, err
	}
	a, b := in.A, in.B
	if jsLess(b, a) {
		a, b = b, a
	}
	rid := "rel-" + a + "-" + b
	member := in.SubjectA.MemberUID
	if ex := in.Existing; ex != nil {
		if err := need(ex.State != "related", "These subjects are related already."); err != nil {
			return RelationResult{}, err
		}
		if err := need(ex.State != "proposed", "This link is proposed already: it waits for the person."); err != nil {
			return RelationResult{}, err
		}
		return RelationResult{}, fail("The person turned this link down (or removed it): do not propose it again.")
	}
	note := ""
	if in.Note != nil {
		note = Collapse(*in.Note)
	}
	if err := need(jsLen(note) <= InboxMaxRelationNote, tooLong("The note", InboxMaxRelationNote)); err != nil {
		return RelationResult{}, err
	}
	p := InboxPlan(ctx, "relation.proposed", member, nil, sp(a), map[string]any{"relationId": rid, "a": a, "b": b, "note": note}, func(eventID string) []plan.Op {
		return []plan.Op{{Kind: "set", Path: model.Paths.InboxRelation(ctx.WorkspaceID, rid), Data: map[string]any{
			"memberUid":   member,
			"a":           a,
			"b":           b,
			"note":        note,
			"state":       "proposed",
			"proposedBy":  map[string]any{"type": "agent", "id": ctx.Actor.ID},
			"decision":    nil,
			"createdAt":   ServerTime(),
			"updatedAt":   ServerTime(),
			"lastEventId": eventID,
		}}}
	}, "")
	return RelationResult{Plan: p, RelationID: rid, A: a, B: b}, nil
}

// ---------- subject search ----------

// SearchFilters is SubjectSearchFilters.
type SearchFilters struct {
	WaitingForMe *bool    `json:"waitingForMe,omitempty"`
	ActiveDays   *float64 `json:"activeDays,omitempty"`
	HasOpen      *bool    `json:"hasOpen,omitempty"`
	Limit        *float64 `json:"limit,omitempty"`
}

// SearchSubject, SearchThread, SearchMessage and SearchRelation are the rows of SubjectSearchInput.
type SearchSubject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type SearchThread struct {
	ID              string  `json:"id"`
	SubjectID       *string `json:"subjectId"`
	State           string  `json:"state"`
	Title           string  `json:"title"`
	LastMessageAtMs int64   `json:"lastMessageAtMs"`
}
type SearchMessage struct {
	ThreadID     string  `json:"threadId"`
	Direction    string  `json:"direction"`
	Source       string  `json:"source"`
	SenderName   string  `json:"senderName"`
	SenderHandle *string `json:"senderHandle"`
	Text         string  `json:"text"`
}
type SearchRelation struct {
	A     string `json:"a"`
	B     string `json:"b"`
	State string `json:"state"`
	Note  string `json:"note"`
}

// SearchInput is SubjectSearchInput.
type SearchInput struct {
	Query     string           `json:"query"`
	Filters   SearchFilters    `json:"filters"`
	NowMs     int64            `json:"nowMs"`
	Subjects  []SearchSubject  `json:"subjects"`
	Threads   []SearchThread   `json:"threads"`
	Messages  []SearchMessage  `json:"messages"`
	Relations []SearchRelation `json:"relations"`
}

// SubjectLink is a related (or proposed) subject.
type SubjectLink struct {
	SubjectID string `json:"subjectId"`
	Name      string `json:"name"`
	Note      string `json:"note"`
}

// SubjectHit is one subject found.
type SubjectHit struct {
	SubjectID      string        `json:"subjectId"`
	Name           string        `json:"name"`
	Score          int           `json:"score"`
	Matched        []string      `json:"matched"`
	ForYou         int           `json:"forYou"`
	Open           int           `json:"open"`
	Threads        int           `json:"threads"`
	LastActivityAt *string       `json:"lastActivityAt"`
	People         []string      `json:"people"`
	Channels       []string      `json:"channels"`
	Related        []SubjectLink `json:"related"`
	Proposed       []SubjectLink `json:"proposed"`
	lastMs         *int64
}

// SearchResult is searchSubjects' answer.
type SearchResult struct {
	Subjects []SubjectHit `json:"subjects"`
	Total    int          `json:"total"`
}

var matchWeights = []struct {
	k string
	w int
}{{"name", 5}, {"people", 3}, {"channel", 3}, {"thread", 2}, {"text", 1}}

var (
	threadForMember = map[string]bool{"needsYou": true, "yourCall": true}
	threadOpen      = map[string]bool{"investigating": true, "needsYou": true, "yourCall": true, "waiting": true}
)

func distinctSorted(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return jsLess(out[i], out[j]) })
	return out
}

// SearchSubjects is searchSubjects.
func SearchSubjects(in SearchInput) SearchResult {
	f := in.Filters
	limit := 20
	if f.Limit != nil {
		if n := int(math.Floor(*f.Limit)); n != 0 {
			limit = n
		}
	}
	limit = max(1, min(100, limit))
	tokens := strings.FieldsFunc(strings.ToLower(in.Query), jsSpace)
	if len(tokens) > 10 {
		tokens = tokens[:10]
	}
	names := map[string]string{}
	for _, s := range in.Subjects {
		names[s.ID] = s.Name
	}
	bySubject := map[string][]SearchThread{}
	subjectOf := map[string]string{}
	for _, t := range in.Threads {
		if t.SubjectID == nil {
			continue
		}
		if _, ok := names[*t.SubjectID]; !ok {
			continue
		}
		subjectOf[t.ID] = *t.SubjectID
		bySubject[*t.SubjectID] = append(bySubject[*t.SubjectID], t)
	}
	msgs := map[string][]SearchMessage{}
	for _, m := range in.Messages {
		if sid, ok := subjectOf[m.ThreadID]; ok {
			msgs[sid] = append(msgs[sid], m)
		}
	}
	links := func(sid, state string) []SubjectLink {
		out := []SubjectLink{}
		for _, r := range in.Relations {
			if r.State != state || (r.A != sid && r.B != sid) {
				continue
			}
			o := r.A
			if r.A == sid {
				o = r.B
			}
			n, ok := names[o]
			if !ok {
				continue
			}
			out = append(out, SubjectLink{SubjectID: o, Name: n, Note: r.Note})
		}
		sort.SliceStable(out, func(i, j int) bool {
			if c := jsCmp(out[i].Name, out[j].Name); c != 0 {
				return c < 0
			}
			return jsLess(out[i].SubjectID, out[j].SubjectID)
		})
		return out
	}
	hits := []SubjectHit{}
	for _, s := range in.Subjects {
		threads := bySubject[s.ID]
		ms := msgs[s.ID]
		forYou, open := 0, 0
		var lastMs *int64
		for _, t := range threads {
			if threadForMember[t.State] {
				forYou++
			}
			if threadOpen[t.State] {
				open++
			}
			if lastMs == nil || t.LastMessageAtMs > *lastMs {
				v := t.LastMessageAtMs
				lastMs = &v
			}
		}
		if f.WaitingForMe != nil && *f.WaitingForMe && forYou == 0 {
			continue
		}
		if f.HasOpen != nil && *f.HasOpen && open == 0 {
			continue
		}
		if f.ActiveDays != nil && (lastMs == nil || float64(*lastMs) < float64(in.NowMs)-*f.ActiveDays*86_400_000) {
			continue
		}
		var people, sources []string
		fields := map[string][]string{"name": {strings.ToLower(s.Name)}}
		for _, m := range ms {
			if m.Direction == "in" {
				people = append(people, m.SenderName)
			}
			sources = append(sources, m.Source)
			if m.SenderName != "" {
				fields["people"] = append(fields["people"], strings.ToLower(m.SenderName))
			}
			if m.SenderHandle != nil && *m.SenderHandle != "" {
				fields["people"] = append(fields["people"], strings.ToLower(*m.SenderHandle))
			}
			fields["text"] = append(fields["text"], strings.ToLower(m.Text))
		}
		people = distinctSorted(people)
		channels := distinctSorted(sources)
		fields["channel"] = channels
		for _, t := range threads {
			fields["thread"] = append(fields["thread"], strings.ToLower(t.Title))
		}
		score := 0
		matched := map[string]bool{}
		all := true
		for _, tok := range tokens {
			best := 0
			for _, mw := range matchWeights {
				for _, v := range fields[mw.k] {
					if strings.Contains(v, tok) {
						matched[mw.k] = true
						best = max(best, mw.w)
						break
					}
				}
			}
			if best == 0 {
				all = false
				break
			}
			score += best
		}
		if !all {
			continue
		}
		m := []string{}
		for _, mw := range matchWeights {
			if matched[mw.k] {
				m = append(m, mw.k)
			}
		}
		var last *string
		if lastMs != nil {
			v := ISOms(time.UnixMilli(*lastMs))
			last = &v
		}
		if len(people) > 10 {
			people = people[:10]
		}
		hits = append(hits, SubjectHit{SubjectID: s.ID, Name: s.Name, Score: score, Matched: m, ForYou: forYou, Open: open,
			Threads: len(threads), LastActivityAt: last, People: people, Channels: channels,
			Related: links(s.ID, "related"), Proposed: links(s.ID, "proposed"), lastMs: lastMs})
	}
	sort.SliceStable(hits, func(i, j int) bool {
		x, y := hits[i], hits[j]
		if x.Score != y.Score {
			return x.Score > y.Score
		}
		if x.ForYou != y.ForYou {
			return x.ForYou > y.ForYou
		}
		if (x.lastMs == nil) != (y.lastMs == nil) {
			return y.lastMs == nil
		}
		if x.lastMs != nil && *x.lastMs != *y.lastMs {
			return *x.lastMs > *y.lastMs
		}
		if c := jsCmp(x.Name, y.Name); c != 0 {
			return c < 0
		}
		return jsLess(x.SubjectID, y.SubjectID)
	})
	total := len(hits)
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return SearchResult{Subjects: hits, Total: total}
}
