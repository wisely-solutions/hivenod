package hive

import (
	"strings"
	"testing"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

func TestToolInScope(t *testing.T) {
	inbox := model.Agent{Scope: "inbox", ProjectIDs: "*"}
	for _, n := range []string{"list_work", "claim", "read_item", "complete", "create_item", "raise_finding", "report_usage", "log", "calendar_free", "calendar_sync"} {
		if ToolInScope(inbox, n) {
			t.Errorf("an inbox agent may not use %s", n)
		}
		if !ToolInScope(model.Agent{ProjectIDs: "*"}, n) {
			t.Errorf("a project agent may use %s", n)
		}
	}
	for _, n := range []string{"inbox_add", "subject_list", "thread_assign", "outcome_propose"} {
		if !ToolInScope(inbox, n) {
			t.Errorf("an inbox agent may use %s", n)
		}
	}
}

func TestWhoTextInbox(t *testing.T) {
	s := "inbox"
	txt := Who{Name: "Personal", AgentUID: "a", WorkspaceID: "w", ProjectIDs: []string{}, Scope: &s}.Text()
	if want := "scope: Inbox only (no development projects)"; !strings.Contains(txt, want) {
		t.Fatalf("%q lacks %q", txt, want)
	}
}
