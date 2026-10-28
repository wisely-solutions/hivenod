package actions

import "testing"

// The same vector is checked by packages/agent/src/inbox.test.ts (node:crypto).
func TestInboxIDs(t *testing.T) {
	if got, want := Digest24(InboxMessageKey("joao", "teams", "thread-1", "m-1")), "4132746f6e2a378b2b6b740b"; got != want {
		t.Fatalf("message digest = %s, want %s", got, want)
	}
	if got, want := Digest24(InboxThreadKey("joao", "teams", "thread-1")), "44c86252e46c927f020ca6f3"; got != want {
		t.Fatalf("thread digest = %s, want %s", got, want)
	}
}

func TestHTTPLink(t *testing.T) {
	for s, want := range map[string]bool{
		"https://x.example/a": true, "http://x": true, "https://": false, "ftp://x": false,
		"https://a b": false, "https://a b": false, " https://x": false,
	} {
		if httpLink(s) != want {
			t.Errorf("httpLink(%q) = %v", s, !want)
		}
	}
}

func TestOutcomeRegistry(t *testing.T) {
	if len(Outcomes) == 0 || Outcomes[0].ID != "reply" || Outcomes[0].Fields[0].Name != "text" {
		t.Fatalf("registry order: %+v", Outcomes)
	}
}
