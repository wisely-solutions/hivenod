package actions

// Inbox plans (item qwFAWxZM5xkcE7PPjAzi): the registry's plan fields as the Go CLI reads them.

import (
	"reflect"
	"testing"
)

func TestOutcomeKindsAndPlanTypes(t *testing.T) {
	if k := OutcomeTypeOf("approval").Kind; k != "human" {
		t.Fatalf("approval kind %q, want human", k)
	}
	for _, typ := range Outcomes {
		if typ.ID != "approval" && typ.Kind != "agent" {
			t.Errorf("%s kind %q, want agent (the default)", typ.ID, typ.Kind)
		}
		if typ.PlanOnly && !typ.Plan && !typ.Retired {
			t.Errorf("%s is plan-only but not a plan type", typ.ID)
		}
	}
	wantPlan := []string{"reply", "handover", "snooze", "nudge", "shape", "build", "keepgreen", "release", "approval"}
	if got := PlanOutcomeTypes(); !reflect.DeepEqual(got, wantPlan) {
		t.Errorf("plan types %v, want %v", got, wantPlan)
	}
	wantSingle := []string{"reply", "no_reply", "handover", "snooze", "nudge", "ignore"}
	if got := SingleOutcomeTypes(); !reflect.DeepEqual(got, wantSingle) {
		t.Errorf("single types %v, want %v", got, wantSingle)
	}
	// Scheduled tasks: a schedule is proposed only with schedule_propose (slice 5), never alone.
	if s := OutcomeTypeOf("schedule"); s == nil || s.OwnTool != "schedule_propose" || s.Plan || s.Executor != "none" {
		t.Errorf("schedule type %+v, want ownTool schedule_propose, no plan step, executor none", s)
	}
	// Bookings were retired with Calendar (item OE8FmrTaIxFVGcaeGG3N, slice 5).
	// make_it_work (Build it) with Projects (slice 11).
	for _, id := range []string{"reply_book", "book", "make_it_work"} {
		if !OutcomeTypeOf(id).Retired {
			t.Errorf("%s is not retired", id)
		}
	}
}
