package actions

import (
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

func sptr(s string) *string { return &s }

// The takeover decision of a starting channel session (item N0biX).
func TestStartDecision(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	seen := now.Add(-30 * time.Second)
	long := now.Add(-3 * time.Minute)
	out := now.Add(-10 * time.Second)
	live := func(host, session *string) model.Agent {
		return model.Agent{LastSeenAt: &seen, SeenHost: sptr("box"), SeenHostID: host, SeenSession: session}
	}
	cases := []struct {
		name  string
		agent model.Agent
		want  string
	}{
		{"never seen", model.Agent{}, PresenceFree},
		{"presence expired", model.Agent{LastSeenAt: &long, SeenHostID: sptr("other"), SeenSession: sptr("s0")}, PresenceFree},
		{"signed out (clean exit)", model.Agent{LastSeenAt: &seen, SignedOutAt: &out, SeenHostID: sptr("other")}, PresenceFree},
		{"same machine, new session: take over", live(sptr("h1"), sptr("s0")), PresenceTakeOver},
		{"same machine, old CLI without session id: take over", live(sptr("h1"), nil), PresenceTakeOver},
		{"other machine: busy", live(sptr("h2"), sptr("s0")), PresenceBusy},
		{"older CLI that writes no host id: busy", live(nil, nil), PresenceBusy},
		{"its own presence", live(sptr("h2"), sptr("s1")), PresenceFree},
	}
	for _, c := range cases {
		if got := StartDecision(c.agent, now.UnixMilli(), "h1", "s1"); got != c.want {
			t.Errorf("%s: got %s, want %s", c.name, got, c.want)
		}
	}
	// A session that knows no host id never takes over.
	if got := StartDecision(live(sptr(""), sptr("s0")), now.UnixMilli(), "", "s1"); got != PresenceBusy {
		t.Errorf("no host id: got %s, want busy", got)
	}
}

func TestTakenOver(t *testing.T) {
	now := time.UnixMilli(1_800_000_000_000)
	seen := now.Add(-5 * time.Second)
	long := now.Add(-3 * time.Minute)
	if TakenOver(model.Agent{LastSeenAt: &seen, SeenSession: sptr("s1")}, now.UnixMilli(), "s1") {
		t.Error("its own presence is not a takeover")
	}
	if !TakenOver(model.Agent{LastSeenAt: &seen, SeenSession: sptr("s2")}, now.UnixMilli(), "s1") {
		t.Error("a live presence of another session is a takeover")
	}
	if TakenOver(model.Agent{LastSeenAt: &long, SeenSession: sptr("s2")}, now.UnixMilli(), "s1") {
		t.Error("an expired presence is not a takeover")
	}
	if TakenOver(model.Agent{LastSeenAt: &seen}, now.UnixMilli(), "s1") {
		t.Error("an older CLI's presence (no session id) is not a takeover")
	}
}
