package actions

import "testing"

// The same vector is checked by packages/agent/src/inbox.test.ts (node:crypto).
func TestInboxRequestID(t *testing.T) {
	got := InboxRequestID(InboxRequestKey("teams", "thread-1", "m-1"))
	if want := "rq298f1b1c3ec51e286529c8d0"; got != want {
		t.Fatalf("InboxRequestID = %s, want %s", got, want)
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
