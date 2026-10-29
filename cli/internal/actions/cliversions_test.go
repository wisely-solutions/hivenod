package actions

import (
	"regexp"
	"testing"
)

func TestEventMinVersion(t *testing.T) {
	if EventMinVersion("revise") != "0.2.163" {
		t.Fatalf("revise needs %q", EventMinVersion("revise"))
	}
	if EventMinVersion("new") != "" {
		t.Fatal("a kind without a row has no minimum")
	}
	re := regexp.MustCompile(`^\d+\.\d+\.\d+$`)
	for _, k := range EventKinds() {
		if !re.MatchString(EventMinVersion(k)) {
			t.Fatalf("%s: malformed %q", k, EventMinVersion(k))
		}
	}
}

func TestSupportsEvent(t *testing.T) {
	cases := []struct {
		kind, have string
		want       bool
	}{
		{"revise", "0.2.159", false}, {"revise", "0.2.163", true}, {"revise", "0.2.1000", true},
		{"revise", "0.10.0", true}, {"revise", "0.2.9", false}, {"new", "0.0.1", true},
	}
	for _, c := range cases {
		if got := SupportsEvent(c.kind, c.have); got != c.want {
			t.Errorf("%s on %s: %v", c.kind, c.have, got)
		}
	}
	if CompareVersions("1.0", "1.0.0") != 0 {
		t.Fatal("trailing zero")
	}
}
