package actions

import (
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// agents.ts.

// AgentOnlineMs: an agent counts as online this long after it was last seen.
const AgentOnlineMs = 2 * 60_000

// Guardrails with the defaults filled in.
type Guardrails struct {
	MaxFailedRuns int64 `json:"maxFailedRuns"`
}

// GuardrailsOf is the agent's guardrails, with the defaults for agents created before them.
func GuardrailsOf(agent model.Agent) Guardrails {
	if agent.Guardrails != nil && agent.Guardrails.MaxFailedRuns != nil {
		return Guardrails{MaxFailedRuns: *agent.Guardrails.MaxFailedRuns}
	}
	return Guardrails{MaxFailedRuns: model.DefaultMaxFailedRuns}
}

// IsPaused: the agent paused itself after too many failed runs.
func IsPaused(agent model.Agent) bool { return agent.PausedAt != nil }

// Terminal is the live terminal's presence.
type Terminal struct {
	Host  *string
	Since time.Time
}

// LiveTerminal is the agent's live terminal, or nil when none is alive (nowMs: Unix ms).
func LiveTerminal(agent model.Agent, nowMs int64) *Terminal {
	var seen, out int64
	if agent.LastSeenAt != nil {
		seen = agent.LastSeenAt.UnixMilli()
	}
	if agent.SignedOutAt != nil {
		out = agent.SignedOutAt.UnixMilli()
	}
	if seen == 0 || seen <= out || nowMs-seen >= AgentOnlineMs {
		return nil
	}
	return &Terminal{Host: agent.SeenHost, Since: time.UnixMilli(seen).UTC()}
}

// Presence decisions of a starting channel session (item N0biX).
const (
	// PresenceFree: no other live session of this agent.
	PresenceFree = "free"
	// PresenceTakeOver: the live presence is an earlier session of this agent on the same machine
	// (a restart after a crash or kill): the new session takes over at once.
	PresenceTakeOver = "takeover"
	// PresenceBusy: another live session on another machine (or one that does not say where it
	// runs, an older CLI): this session gets no handovers.
	PresenceBusy = "busy"
)

// StartDecision is what a starting session with this host id and session id does about the
// agent's presence (nowMs: Unix ms).
func StartDecision(agent model.Agent, nowMs int64, hostID, sessionID string) string {
	if LiveTerminal(agent, nowMs) == nil {
		return PresenceFree
	}
	if agent.SeenSession != nil && *agent.SeenSession == sessionID && sessionID != "" {
		return PresenceFree // its own presence
	}
	if hostID != "" && agent.SeenHostID != nil && *agent.SeenHostID == hostID {
		return PresenceTakeOver
	}
	return PresenceBusy
}

// TakenOver: a running session (sessionID) sees on its heartbeat that another live session of
// this agent replaced its presence (item N0biX); it then stops taking work.
func TakenOver(agent model.Agent, nowMs int64, sessionID string) bool {
	if sessionID == "" || agent.SeenSession == nil || *agent.SeenSession == "" || *agent.SeenSession == sessionID {
		return false
	}
	return LiveTerminal(agent, nowMs) != nil
}
