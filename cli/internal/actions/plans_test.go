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
		if typ.PlanOnly && !typ.Plan {
			t.Errorf("%s is plan-only but not a plan type", typ.ID)
		}
	}
	wantPlan := []string{"reply", "reply_book", "book", "make_it_work", "handover", "snooze", "nudge", "approval"}
	if got := PlanOutcomeTypes(); !reflect.DeepEqual(got, wantPlan) {
		t.Errorf("plan types %v, want %v", got, wantPlan)
	}
	wantSingle := []string{"reply", "reply_book", "no_reply", "make_it_work", "handover", "snooze", "nudge", "ignore"}
	if got := SingleOutcomeTypes(); !reflect.DeepEqual(got, wantSingle) {
		t.Errorf("single types %v, want %v", got, wantSingle)
	}
}
