package actions

// Scheduled tasks, slice 5 (agents propose schedules): the Go port of the parts of
// packages/shared/src/schedules.ts the agent needs (checkRule, ruleSentence, nextRuns) and of
// proposeSchedule / reviseSchedule in scheduleActions.ts. TypeScript stays the source of truth:
// cli/contract/scheduleCases.ts holds the contract cases. Timing is still decided by the
// scheduler (the notifier); nextRuns here only shows schedule_list's next runs.

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	// The zone database inside the binary: the CLI runs on hosts without one (Windows, scratch).
	_ "time/tzdata"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// ScheduleFreqs are SCHEDULE_FREQS.
var ScheduleFreqs = []string{"once", "daily", "weekly", "monthly", "quarterly", "yearly"}

// DefaultScheduleTZ is DEFAULT_SCHEDULE_TZ.
const DefaultScheduleTZ = "Europe/Lisbon"

// SCHEDULE_LIMITS.
const (
	ScheduleMaxTitle    = 80
	ScheduleMaxWhat     = 4000
	ScheduleMaxRunTitle = 100
	ScheduleMaxTZ       = 64
)

var (
	monthNames = []string{"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"}
	dayNames   = []string{"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
	ymdRe      = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})$`)
	atRe       = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)
	// RuleKeys is RULE_KEYS, in order.
	RuleKeys = []string{"freq", "at", "tz", "date", "weekdays", "monthDay", "month", "weekend", "until"}
)

func monthName(m int) string {
	if m < 1 || m > 12 {
		return "?"
	}
	return monthNames[m-1]
}

func dayName(d int) string {
	if d < 1 || d > 7 {
		return "?"
	}
	return dayNames[d-1]
}

type ymd struct{ y, m, d int }

func (v ymd) String() string { return pad4(v.y) + "-" + pad2(v.m) + "-" + pad2(v.d) }

func pad2(n int) string { return padN(n, 2) }
func pad4(n int) string { return padN(n, 4) }
func padN(n, w int) string {
	s := strconv.Itoa(n)
	for len(s) < w {
		s = "0" + s
	}
	return s
}

const dayMs = 86_400_000

func dayNum(v ymd) int64 {
	return time.Date(v.y, time.Month(v.m), v.d, 0, 0, 0, 0, time.UTC).UnixMilli() / dayMs
}

func fromDayNum(n int64) ymd {
	t := time.UnixMilli(n * dayMs).UTC()
	return ymd{t.Year(), int(t.Month()), t.Day()}
}

func addDays(v ymd, n int) ymd { return fromDayNum(dayNum(v) + int64(n)) }

// DaysInMonth is daysInMonth.
func DaysInMonth(y, m int) int {
	return time.Date(y, time.Month(m)+1, 0, 0, 0, 0, 0, time.UTC).Day()
}

func isoWeekday(v ymd) int {
	w := int(time.Date(v.y, time.Month(v.m), v.d, 0, 0, 0, 0, time.UTC).Weekday())
	if w == 0 {
		return 7
	}
	return w
}

func cmpYmd(a, b ymd) int64 { return dayNum(a) - dayNum(b) }

func parseYmd(v any) (ymd, bool) {
	s, ok := v.(string)
	if !ok {
		return ymd{}, false
	}
	m := ymdRe.FindStringSubmatch(s)
	if m == nil {
		return ymd{}, false
	}
	y, _ := strconv.Atoi(m[1])
	mo, _ := strconv.Atoi(m[2])
	d, _ := strconv.Atoi(m[3])
	if mo < 1 || mo > 12 || d < 1 || d > DaysInMonth(y, mo) {
		return ymd{}, false
	}
	return ymd{y, mo, d}, true
}

func parseAt(v any) (h, min int, ok bool) {
	s, isStr := v.(string)
	if !isStr {
		return 0, 0, false
	}
	m := atRe.FindStringSubmatch(s)
	if m == nil {
		return 0, 0, false
	}
	h, _ = strconv.Atoi(m[1])
	min, _ = strconv.Atoi(m[2])
	return h, min, true
}

// zone is the IANA zone, or nil when it is unknown ("Local" and "" are never zones).
func zone(tz any) *time.Location {
	s, ok := tz.(string)
	if !ok || s == "" || s == "Local" {
		return nil
	}
	loc, err := time.LoadLocation(s)
	if err != nil {
		return nil
	}
	return loc
}

// IsTimeZone is isTimeZone.
func IsTimeZone(tz any) bool { return zone(tz) != nil }

// toNum is a number value (JSON float64 or Firestore int64).
func toNum(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

// isInt is Number.isInteger for a decoded JSON value.
func isInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if n == math.Trunc(n) && !math.IsInf(n, 0) {
			return int(n), true
		}
	case int:
		return n, true
	case int64:
		return int(n), true
	}
	return 0, false
}

// CheckRule is checkRule: plain errors for a rule (a decoded JSON object); empty when valid.
func CheckRule(rule any) []string {
	errs := []string{}
	r, ok := rule.(map[string]any)
	if !ok {
		return []string{"rule: required"}
	}
	freq, _ := r["freq"].(string)
	if !inList(freq, ScheduleFreqs...) {
		return []string{"freq: one of " + strings.Join(ScheduleFreqs, ", ")}
	}
	has := func(k string) bool { _, ok := r[k]; return ok }
	if _, _, ok := parseAt(r["at"]); !ok {
		errs = append(errs, "at: HH:MM between 00:00 and 23:59")
	}
	if has("tz") && !IsTimeZone(r["tz"]) {
		errs = append(errs, "tz: unknown time zone")
	}
	if _, ok := parseYmd(r["date"]); has("date") && !ok {
		errs = append(errs, "date: a real day as YYYY-MM-DD")
	}
	if _, ok := parseYmd(r["until"]); has("until") && r["until"] != nil && !ok {
		errs = append(errs, "until: a real day as YYYY-MM-DD")
	}
	if freq == "once" && !has("date") {
		errs = append(errs, "once needs date")
	}
	if freq == "once" && r["until"] != nil {
		errs = append(errs, "until: not for once")
	}
	start, sok := parseYmd(r["date"])
	end, eok := parseYmd(r["until"])
	if sok && eok && cmpYmd(end, start) < 0 {
		errs = append(errs, "until: on or after date")
	}

	usesWeekdays := freq == "daily" || freq == "weekly"
	if has("weekdays") {
		w, isList := r["weekdays"].([]any)
		if !usesWeekdays {
			errs = append(errs, "weekdays: only for daily or weekly")
		} else {
			bad := !isList || len(w) < 1 || len(w) > 7
			seen := map[int]bool{}
			for _, e := range w {
				d, ok := isInt(e)
				if !ok || d < 1 || d > 7 || seen[d] {
					bad = true
				}
				seen[d] = true
			}
			if bad {
				errs = append(errs, "weekdays: 1..7 distinct days, 1 = Monday … 7 = Sunday")
			}
		}
	} else if freq == "weekly" {
		errs = append(errs, "weekly needs weekdays")
	}

	usesMonthDay := freq == "monthly" || freq == "quarterly" || freq == "yearly"
	if usesMonthDay {
		if !has("monthDay") {
			errs = append(errs, freq+" needs monthDay")
		} else if d, ok := isInt(r["monthDay"]); !ok || !(d == -1 || (d >= 1 && d <= 31)) {
			errs = append(errs, "monthDay: 1..31 or -1")
		}
	} else if has("monthDay") {
		errs = append(errs, "monthDay: only for monthly, quarterly or yearly")
	}

	if freq == "yearly" || freq == "quarterly" {
		if !has("month") {
			if freq == "yearly" {
				errs = append(errs, "yearly needs month")
			}
		} else if m, ok := isInt(r["month"]); !ok || m < 1 || m > 12 {
			errs = append(errs, "month: 1..12")
		} else if md, isNum := toNum(r["monthDay"]); freq == "yearly" && isNum && md > float64(DaysInMonth(2028, m)) {
			// 2028: a leap year, so 29 Feb is allowed
			errs = append(errs, "monthDay: "+monthName(m)+" has at most "+strconv.Itoa(DaysInMonth(2028, m))+" days")
		}
	} else if has("month") {
		errs = append(errs, "month: only for quarterly or yearly")
	}

	if has("weekend") {
		w, _ := r["weekend"].(string)
		if !inList(w, "keep", "before", "after") {
			errs = append(errs, "weekend: keep, before or after")
		} else if !usesMonthDay && w != "keep" {
			errs = append(errs, "weekend: only for monthly, quarterly or yearly")
		}
	}
	return errs
}

// ScheduleRule is a checked rule (CheckRule found nothing wrong).
type ScheduleRule struct {
	Freq     string
	At       string
	TZ       string
	Date     *ymd
	Weekdays []int
	MonthDay int
	Month    int
	Weekend  string
	Until    *ymd
}

// RuleOf reads a checked rule; an error when CheckRule refuses it.
func RuleOf(rule any) (ScheduleRule, error) {
	if errs := CheckRule(rule); len(errs) > 0 {
		return ScheduleRule{}, fail("Invalid schedule rule: " + strings.Join(errs, "; "))
	}
	r := rule.(map[string]any)
	out := ScheduleRule{TZ: DefaultScheduleTZ, MonthDay: 1, Month: 1}
	out.Freq, _ = r["freq"].(string)
	out.At, _ = r["at"].(string)
	if s, ok := r["tz"].(string); ok {
		out.TZ = s
	}
	if d, ok := parseYmd(r["date"]); ok {
		out.Date = &d
	}
	if d, ok := parseYmd(r["until"]); ok {
		out.Until = &d
	}
	if w, ok := r["weekdays"].([]any); ok {
		for _, e := range w {
			n, _ := isInt(e)
			out.Weekdays = append(out.Weekdays, n)
		}
	}
	if n, ok := isInt(r["monthDay"]); ok {
		out.MonthDay = n
	}
	if n, ok := isInt(r["month"]); ok {
		out.Month = n
	}
	out.Weekend, _ = r["weekend"].(string)
	return out, nil
}

// ---------- words ----------

// TZCity is tzCity.
func TZCity(tz string) string {
	parts := strings.Split(tz, "/")
	return strings.ReplaceAll(parts[len(parts)-1], "_", " ")
}

func weekdayList(days []int) string {
	set := map[int]bool{}
	var sorted []int
	for _, d := range days {
		if !set[d] {
			set[d] = true
			sorted = append(sorted, d)
		}
	}
	sort.Ints(sorted)
	var runs [][]int
	for _, d := range sorted {
		if n := len(runs); n > 0 && d == runs[n-1][len(runs[n-1])-1]+1 {
			runs[n-1] = append(runs[n-1], d)
		} else {
			runs = append(runs, []int{d})
		}
	}
	parts := make([]string, len(runs))
	for i, r := range runs {
		if len(r) >= 3 {
			parts[i] = dayName(r[0]) + "–" + dayName(r[len(r)-1])
		} else {
			names := make([]string, len(r))
			for j, d := range r {
				names[j] = dayName(d)
			}
			parts[i] = strings.Join(names, ", ")
		}
	}
	return strings.Join(parts, ", ")
}

func dayWord(d int) string {
	if d == -1 {
		return "last day"
	}
	return "day " + strconv.Itoa(d)
}

func dateWord(v ymd) string {
	return strconv.Itoa(v.d) + " " + monthName(v.m) + " " + strconv.Itoa(v.y)
}

// RuleSentence is ruleSentence (viewer zone Europe/Lisbon): 'Monthly · day 1 · 09:00'.
func RuleSentence(r ScheduleRule) string {
	tm := r.At
	if r.TZ != DefaultScheduleTZ {
		tm += " " + TZCity(r.TZ)
	}
	shift := ""
	switch r.Weekend {
	case "before":
		shift = " · Fri if weekend"
	case "after":
		shift = " · Mon if weekend"
	}
	until := ""
	if r.Until != nil {
		until = " · until " + dateWord(*r.Until)
	}
	switch r.Freq {
	case "once":
		day := "?"
		if r.Date != nil {
			day = dayName(isoWeekday(*r.Date)) + " " + dateWord(*r.Date)
		}
		return "Once · " + day + " · " + tm
	case "daily":
		days := ""
		set := map[int]bool{}
		for _, d := range r.Weekdays {
			set[d] = true
		}
		if r.Weekdays != nil && len(set) < 7 {
			days = " · " + weekdayList(r.Weekdays)
		}
		return "Daily" + days + " · " + tm + until
	case "weekly":
		return "Weekly · " + weekdayList(r.Weekdays) + " · " + tm + until
	case "monthly":
		return "Monthly · " + dayWord(r.MonthDay) + " · " + tm + shift + until
	case "quarterly":
		var months []int
		for _, k := range []int{0, 3, 6, 9} {
			months = append(months, (r.Month-1+k)%12+1)
		}
		sort.Ints(months)
		names := make([]string, len(months))
		for i, m := range months {
			names[i] = monthName(m)
		}
		return "Quarterly · " + dayWord(r.MonthDay) + " · " + tm + " (" + strings.Join(names, ", ") + ")" + shift + until
	default: // yearly
		m := monthName(r.Month)
		day := strconv.Itoa(r.MonthDay) + " " + m
		if r.MonthDay == -1 {
			day = "last day of " + m
		}
		return "Yearly · " + day + " · " + tm + shift + until
	}
}

// ---------- occurrences (schedule_list's next runs) ----------

// Occurrence is one run of a rule.
type Occurrence struct {
	Key     string `json:"key"`
	DueMs   int64  `json:"dueMs"`
	Local   string `json:"local"`
	Date    string `json:"date"`
	Period  string `json:"period"`
	Year    int    `json:"year"`
	Month   int    `json:"month"`
	Quarter int    `json:"quarter"`
}

type localTime struct {
	ymd
	h, min int
}

func localParts(ms int64, loc *time.Location) localTime {
	t := time.UnixMilli(ms).In(loc)
	return localTime{ymd{t.Year(), int(t.Month()), t.Day()}, t.Hour(), t.Minute()}
}

func utcMs(v ymd, h, min int) int64 {
	return time.Date(v.y, time.Month(v.m), v.d, h, min, 0, 0, time.UTC).UnixMilli()
}

func floorDiv(a, b int64) int64 {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

func tzOffsetMs(ms int64, loc *time.Location) int64 {
	whole := floorDiv(ms, 60_000) * 60_000
	l := localParts(whole, loc)
	return utcMs(l.ymd, l.h, l.min) - whole
}

// localToUtc is localToUtc: a DST gap moves forward by the gap; an overlap takes the first.
func localToUtc(v ymd, h, min int, loc *time.Location) int64 {
	naive := utcMs(v, h, min)
	before := naive - tzOffsetMs(naive-12*3_600_000, loc)
	after := naive - tzOffsetMs(naive+12*3_600_000, loc)
	best, found := int64(0), false
	for _, t := range []int64{before, after} {
		l := localParts(t, loc)
		if l.ymd == v && l.h == h && l.min == min && (!found || t < best) {
			best, found = t, true
		}
	}
	if found {
		return best
	}
	return before
}

func quarterOf(m int) int { return (m-1)/3 + 1 }

type period struct {
	y, m int
	run  ymd
}

func runKeyOf(freq, date string, year, month int) string {
	switch freq {
	case "once":
		return "once"
	case "daily", "weekly":
		return date
	case "monthly":
		return pad4(year) + "-" + pad2(month)
	case "quarterly":
		return pad4(year) + "-Q" + strconv.Itoa(quarterOf(month))
	}
	return pad4(year)
}

func periodLabel(freq string, p period) string {
	switch freq {
	case "once", "daily", "weekly":
		return strconv.Itoa(p.run.d) + " " + monthName(p.run.m) + " " + strconv.Itoa(p.run.y)
	case "monthly":
		return monthName(p.m) + " " + strconv.Itoa(p.y)
	case "quarterly":
		return "Q" + strconv.Itoa(quarterOf(p.m)) + " " + strconv.Itoa(p.y)
	}
	return strconv.Itoa(p.y)
}

func monthRun(r ScheduleRule, y, m int) ymd {
	last := DaysInMonth(y, m)
	day := r.MonthDay
	if r.MonthDay == -1 || r.MonthDay > last {
		day = last
	}
	run := ymd{y, m, day}
	wd := isoWeekday(run)
	if wd >= 6 && r.Weekend == "before" {
		run = addDays(run, -(wd - 5))
	}
	if wd >= 6 && r.Weekend == "after" {
		run = addDays(run, 8-wd)
	}
	return run
}

// periods returns a generator of the rule's periods from the one containing `from`.
func periods(r ScheduleRule, from ymd) func() (period, bool) {
	switch r.Freq {
	case "once":
		done := false
		return func() (period, bool) {
			if done || r.Date == nil {
				return period{}, false
			}
			done = true
			return period{r.Date.y, r.Date.m, *r.Date}, true
		}
	case "daily", "weekly":
		days := map[int]bool{}
		if r.Weekdays == nil {
			for d := 1; d <= 7; d++ {
				days[d] = true
			}
		}
		for _, d := range r.Weekdays {
			days[d] = true
		}
		n := dayNum(from) - 1
		return func() (period, bool) {
			for {
				n++
				d := fromDayNum(n)
				if days[isoWeekday(d)] {
					return period{d.y, d.m, d}, true
				}
			}
		}
	case "monthly", "quarterly":
		step, anchor := 1, 1
		if r.Freq == "quarterly" {
			step, anchor = 3, r.Month
		}
		idx := from.y*12 + (from.m - 1) - step
		idx -= (((idx - (anchor - 1)) % step) + step) % step
		idx -= step
		return func() (period, bool) {
			idx += step
			y := idx / 12
			m := idx%12 + 1
			return period{y, m, monthRun(r, y, m)}, true
		}
	default: // yearly
		y := from.y - 2
		return func() (period, bool) {
			y++
			return period{y, r.Month, monthRun(r, y, r.Month)}, true
		}
	}
}

const maxPeriods = 20_000

// Occurrences is occurrences: the runs due in [fromMs, toMs], in order, at most max.
func Occurrences(r ScheduleRule, fromMs, toMs int64, max int) []Occurrence {
	out := []Occurrence{}
	if max <= 0 || toMs < fromMs {
		return out
	}
	loc := zone(r.TZ)
	if loc == nil {
		return out
	}
	h, min, _ := parseAt(r.At)
	from := addDays(localParts(fromMs, loc).ymd, -3)
	if r.Date != nil && cmpYmd(*r.Date, from) > 0 {
		from = *r.Date
	}
	next := periods(r, from)
	for seen := 1; seen <= maxPeriods; seen++ {
		p, ok := next()
		if !ok {
			break
		}
		if r.Until != nil && cmpYmd(p.run, *r.Until) > 0 {
			break
		}
		if r.Date != nil && cmpYmd(p.run, *r.Date) < 0 {
			continue
		}
		due := localToUtc(p.run, h, min, loc)
		if due > toMs {
			break
		}
		if due < fromMs {
			continue
		}
		l := localParts(due, loc)
		daily := r.Freq == "once" || r.Freq == "daily" || r.Freq == "weekly"
		year, month := p.y, p.m
		if daily {
			year, month = p.run.y, p.run.m
		}
		date := p.run.String()
		out = append(out, Occurrence{
			Key: runKeyOf(r.Freq, date, year, month), DueMs: due,
			Local: l.ymd.String() + " " + pad2(l.h) + ":" + pad2(l.min), Date: date,
			Period: periodLabel(r.Freq, p), Year: year, Month: month, Quarter: quarterOf(month),
		})
		if len(out) >= max {
			break
		}
	}
	return out
}

// NextRuns is nextRuns: the next n runs from fromMs (inclusive).
func NextRuns(r ScheduleRule, fromMs int64, n int) []Occurrence {
	return Occurrences(r, fromMs, math.MaxInt64, n)
}

// ---------- proposing (scheduleActions.ts) ----------

// ScheduleStep is one step of each run's plan.
type ScheduleStep struct {
	Type   string         `json:"type" firestore:"type"`
	Fields map[string]any `json:"fields" firestore:"fields"`
}

// ScheduleInput is ScheduleInput: what a proposal gives for a schedule.
type ScheduleInput struct {
	Title      string          `json:"title"`
	What       string          `json:"what"`
	Rule       any             `json:"rule"`
	RunTitle   *string         `json:"runTitle"`
	Steps      []PlanStepInput `json:"steps"`
	TemplateID *string         `json:"templateId"`
	SubjectID  *string         `json:"subjectId"`
}

// OptString is an optional string argument that tells a left-out key from null.
type OptString struct {
	Set bool
	Val *string
}

// UnmarshalJSON runs only when the key is there.
func (o *OptString) UnmarshalJSON(b []byte) error {
	o.Set = true
	return json.Unmarshal(b, &o.Val)
}

// ScheduleState is what the actions need of a schedule (ScheduleOf).
type ScheduleState struct {
	MemberUID  string         `json:"memberUid"`
	AgentUID   string         `json:"agentUid"`
	Title      string         `json:"title"`
	What       string         `json:"what"`
	Rule       map[string]any `json:"rule"`
	RunTitle   string         `json:"runTitle"`
	Steps      []ScheduleStep `json:"steps"`
	TemplateID *string        `json:"templateId"`
	SubjectID  *string        `json:"subjectId"`
	State      string         `json:"state"`
	Proposal   *struct {
		ThreadID  string `json:"threadId"`
		OutcomeID string `json:"outcomeId"`
		By        string `json:"by"`
	} `json:"proposal"`
	Replaces *string `json:"replaces"`
	Version  int     `json:"version"`
}

// ScheduleStateFrom is the action state of a stored schedule.
func ScheduleStateFrom(s model.Schedule) ScheduleState {
	out := ScheduleState{MemberUID: s.MemberUID, AgentUID: s.AgentUID, Title: s.Title, What: s.What, Rule: s.Rule,
		RunTitle: s.RunTitle, TemplateID: s.TemplateID, SubjectID: s.SubjectID, State: s.State, Replaces: s.Replaces, Version: int(s.Version)}
	for _, st := range s.Steps {
		out.Steps = append(out.Steps, ScheduleStep{Type: st.Type, Fields: st.Fields})
	}
	if s.Proposal != nil {
		out.Proposal = &struct {
			ThreadID  string `json:"threadId"`
			OutcomeID string `json:"outcomeId"`
			By        string `json:"by"`
		}{s.Proposal.ThreadID, s.Proposal.OutcomeID, s.Proposal.By}
	}
	return out
}

// SchedulePath is schedulePaths.schedule.
func SchedulePath(w, s string) string { return "workspaces/" + w + "/schedules/" + s }

// CleanRule is cleanRule: only the known keys (in order), checked.
func CleanRule(rule any) (map[string]any, error) {
	r, ok := rule.(map[string]any)
	if !ok {
		return nil, fail("A schedule needs a rule.")
	}
	var extra []string
	for k := range r {
		if !inList(k, RuleKeys...) {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	if len(extra) > 0 {
		return nil, fail("The rule has no " + strings.Join(extra, ", ") + ".")
	}
	out := map[string]any{}
	for _, k := range RuleKeys {
		if v, ok := r[k]; ok {
			out[k] = v
		}
	}
	if errs := CheckRule(out); len(errs) > 0 {
		return nil, fail("The rule: " + strings.Join(errs, "; ") + ".")
	}
	if tz, ok := out["tz"].(string); ok && jsLen(tz) > ScheduleMaxTZ {
		return nil, fail("The time zone name is too long.")
	}
	return out, nil
}

func scheduleLine(what string, v *string, max int) (string, error) {
	t := ""
	if v != nil {
		t = Collapse(*v)
	}
	if t == "" {
		return "", fail(what + " is empty.")
	}
	if jsLen(t) > max {
		return "", fail(what + " is at most " + strconv.Itoa(max) + " characters.")
	}
	return t, nil
}

type cleanSched struct {
	title, what, runTitle string
	rule                  map[string]any
	steps                 []any
	templateID, subjectID *string
}

func (c cleanSched) doc() map[string]any {
	return map[string]any{"title": c.title, "what": c.what, "rule": c.rule, "runTitle": c.runTitle,
		"steps": c.steps, "templateId": strOrNil(c.templateID), "subjectId": strOrNil(c.subjectID)}
}

// cleanSchedule is cleanSchedule.
func cleanSchedule(in ScheduleInput) (cleanSched, error) {
	title, err := scheduleLine("The title", &in.Title, ScheduleMaxTitle)
	if err != nil {
		return cleanSched{}, err
	}
	what := jsTrim(in.What)
	if what == "" {
		return cleanSched{}, fail("Say what to do each time.")
	}
	if jsLen(what) > ScheduleMaxWhat {
		return cleanSched{}, fail("What to do is at most " + strconv.Itoa(ScheduleMaxWhat) + " characters.")
	}
	var runTitle string
	if in.RunTitle != nil && jsTrim(*in.RunTitle) != "" {
		if runTitle, err = scheduleLine("The run title", in.RunTitle, ScheduleMaxRunTitle); err != nil {
			return cleanSched{}, err
		}
	} else {
		runTitle = jsSlice(title, ScheduleMaxRunTitle-11) + " · {period}"
	}
	tpl := trimOrNil(in.TemplateID)
	if tpl != nil && PlanTemplateOf(*tpl) == nil {
		return cleanSched{}, fail("There is no template " + *tpl + ".")
	}
	steps, err := cleanPlanSteps(in.Steps)
	if err != nil {
		return cleanSched{}, err
	}
	list := make([]any, len(steps))
	for i, s := range steps {
		list[i] = map[string]any{"type": s.typ, "fields": s.fields}
	}
	subject := trimOrNil(in.SubjectID)
	if subject != nil && jsLen(*subject) > 128 {
		return cleanSched{}, fail("That subject id is too long.")
	}
	rule, err := CleanRule(in.Rule)
	if err != nil {
		return cleanSched{}, err
	}
	return cleanSched{title, what, runTitle, rule, list, tpl, subject}, nil
}

func scheduleEditable(s ScheduleState) error {
	if s.State == "active" || s.State == "paused" {
		return nil
	}
	if s.State == "proposed" {
		return fail("This schedule is still a proposal: approve or reject it.")
	}
	return fail("This schedule has ended.")
}

func sureness(conf *string, checks []string) ([]string, error) {
	if conf != nil && !inList(*conf, OutcomeConfidence...) {
		return nil, fail("The confidence is high, medium or low.")
	}
	return cleanLines("checks", checks, InboxMaxChecks, InboxMaxCheck)
}

// ProposeScheduleInput is proposeSchedule's input.
type ProposeScheduleInput struct {
	ScheduleInput
	ThreadID   string      `json:"threadId"`
	Thread     ThreadState `json:"thread"`
	Note       *string     `json:"note"`
	Confidence *string     `json:"confidence"`
	Checks     []string    `json:"checks"`
	Replaces   *struct {
		ID       string        `json:"id"`
		Schedule ScheduleState `json:"schedule"`
	} `json:"replaces"`
	ScheduleID *string `json:"scheduleId"`
	OutcomeID  *string `json:"outcomeId"`
}

// ProposeScheduleResult is the plan, the ids and the rule's sentence.
type ProposeScheduleResult struct {
	plan.Plan
	ScheduleID string `json:"scheduleId"`
	OutcomeID  string `json:"outcomeId"`
	Sentence   string `json:"sentence"`
	// Version: a revision's outcome version (reviseSchedule only).
	Version int `json:"version,omitempty"`
}

func ruleSentenceOf(rule map[string]any) string {
	r, err := RuleOf(rule)
	if err != nil {
		return ""
	}
	return jsSlice(RuleSentence(r), 300)
}

// ProposeSchedule is proposeSchedule: a proposed schedule and its `schedule` outcome on the
// member's thread (Your call); only the member's approval activates it.
func ProposeSchedule(ctx Ctx, in ProposeScheduleInput) (ProposeScheduleResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ProposeScheduleResult{}, err
	}
	t := in.Thread
	me := ctx.Actor.ID
	if t.State == "ignored" {
		return ProposeScheduleResult{}, fail("This thread was ignored: bring it back first.")
	}
	if t.FetchedBy != me {
		return ProposeScheduleResult{}, fail("Only the thread’s home agent proposes a schedule on it.")
	}
	var replaces any
	if rep := in.Replaces; rep != nil {
		if rep.Schedule.MemberUID != t.MemberUID {
			return ProposeScheduleResult{}, fail("That schedule is someone else’s.")
		}
		if rep.Schedule.AgentUID != me {
			return ProposeScheduleResult{}, fail("You can only propose changes to schedules you run.")
		}
		if err := scheduleEditable(rep.Schedule); err != nil {
			return ProposeScheduleResult{}, err
		}
		replaces = rep.ID
	}
	c, err := cleanSchedule(in.ScheduleInput)
	if err != nil {
		return ProposeScheduleResult{}, err
	}
	note := ""
	if in.Note != nil {
		note = jsTrim(*in.Note)
	}
	if jsLen(note) > InboxMaxOutcomeNote {
		return ProposeScheduleResult{}, fail("The note is at most " + strconv.Itoa(InboxMaxOutcomeNote) + " characters.")
	}
	checks, err := sureness(in.Confidence, in.Checks)
	if err != nil {
		return ProposeScheduleResult{}, err
	}
	sid := ""
	if in.ScheduleID != nil {
		sid = *in.ScheduleID
	} else {
		sid = ctx.nid()
	}
	oid := ""
	if in.OutcomeID != nil {
		oid = *in.OutcomeID
	} else {
		oid = ctx.nid()
	}
	sentence := ruleSentenceOf(c.rule)
	fields := map[string]any{"scheduleId": sid, "sentence": sentence}
	w := ctx.WorkspaceID
	p := InboxPlan(ctx, "outcome.proposed", t.MemberUID, sp(in.ThreadID), t.SubjectID,
		map[string]any{"outcomeId": oid, "type": "schedule", "fields": fields, "scheduleId": sid}, func(eventID string) []plan.Op {
			sd := merge(map[string]any{"memberUid": t.MemberUID, "agentUid": me}, c.doc(), map[string]any{
				"state": "proposed", "activeFrom": nil,
				"proposal": map[string]any{"threadId": in.ThreadID, "outcomeId": oid, "by": me},
				"replaces": replaces, "version": 1, "createdBy": map[string]any{"type": "agent", "id": me},
				"createdAt": ServerTime(), "updatedAt": ServerTime(), "lastEventId": eventID,
			})
			od := map[string]any{
				"memberUid": t.MemberUID, "threadId": in.ThreadID, "type": "schedule", "fields": fields,
				"state": "proposed", "note": note, "proposedBy": me, "executor": nil, "decision": nil, "result": nil,
				"createdAt": ServerTime(), "updatedAt": ServerTime(), "lastEventId": eventID,
			}
			if in.Confidence != nil {
				od["confidence"] = *in.Confidence
			}
			if len(checks) > 0 {
				od["checks"] = checks
			}
			return []plan.Op{
				{Kind: "set", Path: SchedulePath(w, sid), Data: sd},
				{Kind: "set", Path: model.Paths.InboxOutcome(w, oid), Data: od},
				upd(model.Paths.InboxThread(w, in.ThreadID), map[string]any{"state": "yourCall", "waiting": nil}, eventID),
			}
		}, "")
	return ProposeScheduleResult{Plan: p, ScheduleID: sid, OutcomeID: oid, Sentence: sentence}, nil
}

// ReviseScheduleInput is reviseSchedule's input.
type ReviseScheduleInput struct {
	ScheduleInput
	OutcomeID  string       `json:"outcomeId"`
	Outcome    OutcomeState `json:"outcome"`
	Thread     ThreadState  `json:"thread"`
	ThreadID   *string      `json:"threadId"`
	Note       *string      `json:"note"`
	Confidence *string      `json:"confidence"`
	Checks     []string     `json:"checks"`
	Schedule   struct {
		ID   string        `json:"id"`
		Data ScheduleState `json:"data"`
	} `json:"schedule"`
	// Subject: the subject; left out keeps the proposal's (it shadows ScheduleInput.SubjectID).
	Subject OptString `json:"subjectId"`
}

// ReviseSchedule is reviseSchedule (schedule_propose revises): the proposed schedule rewritten
// and the outcome's next version, in one batch with the outcome.revised event.
func ReviseSchedule(ctx Ctx, in ReviseScheduleInput) (ProposeScheduleResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ProposeScheduleResult{}, err
	}
	o, sc := in.Outcome, in.Schedule
	if o.Type != "schedule" {
		return ProposeScheduleResult{}, fail("Outcome " + in.OutcomeID + " is a " + o.Type + ": revise it with outcome_propose.")
	}
	if id, _ := o.Fields["scheduleId"].(string); sc.ID != id {
		return ProposeScheduleResult{}, fail("Give the schedule this proposal names.")
	}
	if sc.Data.State != "proposed" {
		return ProposeScheduleResult{}, fail("This schedule is no longer a proposal.")
	}
	if sc.Data.AgentUID != ctx.Actor.ID {
		return ProposeScheduleResult{}, fail("Only the agent that proposed this schedule revises it.")
	}
	si := in.ScheduleInput
	si.SubjectID = sc.Data.SubjectID
	if in.Subject.Set {
		si.SubjectID = in.Subject.Val
	}
	c, err := cleanSchedule(si)
	if err != nil {
		return ProposeScheduleResult{}, err
	}
	sentence := ruleSentenceOf(c.rule)
	r, err := reviseOutcomeOps(ctx, ReviseInput{OutcomeID: in.OutcomeID, Outcome: o, Thread: in.Thread,
		Fields: map[string]any{"scheduleId": sc.ID, "sentence": sentence}, Note: in.Note, Confidence: in.Confidence, Checks: in.Checks})
	if err != nil {
		return ProposeScheduleResult{}, err
	}
	ops := append([]plan.Op{}, r.Ops[:len(r.Ops)-1]...)
	ops = append(ops, upd(SchedulePath(ctx.WorkspaceID, sc.ID), merge(c.doc(), map[string]any{"version": sc.Data.Version + 1}), r.EventID), r.Ops[len(r.Ops)-1])
	r.Ops = ops
	return ProposeScheduleResult{Plan: r.Plan, ScheduleID: sc.ID, OutcomeID: in.OutcomeID, Sentence: sentence, Version: r.Version}, nil
}
