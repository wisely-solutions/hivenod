package hive

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
)

// Item DhsO9: an agent creates at most CreateItemLimit items per CreateItemWindow, so a loop
// cannot flood a board. The limit lives in the agent's session code, like max_items (all agents
// are their owner's own); the rules enforce who may create where. Mirrors
// packages/agent/src/ratelimit.ts.
const (
	CreateItemLimit  = 30
	CreateItemWindow = time.Hour
)

// CreateRateMessage is the refusal once the limit is reached; next is when a slot frees.
func CreateRateMessage(limit int, next time.Duration) string {
	mins := int((next + time.Minute - 1) / time.Minute)
	if mins < 1 {
		mins = 1
	}
	unit := "minutes"
	if mins == 1 {
		unit = "minute"
	}
	return fmt.Sprintf("Rate limit: this agent already created %d items in the last hour (at most %d per hour, so a loop cannot flood a board). The next one can be created in %d %s.", limit, limit, mins, unit)
}

// CheckCreateRate keeps the creations (unix ms) still inside the window and refuses when the
// limit is reached. It never records: call Record after a successful create.
func CheckCreateRate(times []int64, nowMs int64, limit int, window time.Duration) ([]int64, error) {
	from := nowMs - window.Milliseconds()
	kept := make([]int64, 0, len(times))
	for _, t := range times {
		if t > from && t <= nowMs {
			kept = append(kept, t)
		}
	}
	if len(kept) >= limit {
		oldest := kept[0]
		for _, t := range kept {
			if t < oldest {
				oldest = t
			}
		}
		return kept, Errf(CreateRateMessage(limit, time.Duration(oldest+window.Milliseconds()-nowMs)*time.Millisecond))
	}
	return kept, nil
}

// CreateLimiter counts this agent's creations, per agent, in a small file next to the token
// (~/.hivenod/created-items.json), so separate CLI runs and MCP sessions on the machine share it.
// Without a usable file it still counts in memory.
type CreateLimiter struct {
	mu     sync.Mutex
	Path   string
	Now    func() time.Time
	Limit  int
	Window time.Duration
	mem    map[string][]int64
}

// NewCreateLimiter is the limiter at the default place and limits.
func NewCreateLimiter() *CreateLimiter {
	return &CreateLimiter{Path: filepath.Join(credentials.Home(), "created-items.json")}
}

func (l *CreateLimiter) now() time.Time {
	if l.Now != nil {
		return l.Now()
	}
	return time.Now()
}

func (l *CreateLimiter) limits() (int, time.Duration) {
	limit, window := l.Limit, l.Window
	if limit <= 0 {
		limit = CreateItemLimit
	}
	if window <= 0 {
		window = CreateItemWindow
	}
	return limit, window
}

func (l *CreateLimiter) load() map[string][]int64 {
	all := map[string][]int64{}
	if l.Path != "" {
		if b, err := os.ReadFile(l.Path); err == nil {
			_ = json.Unmarshal(b, &all)
		}
	}
	for k, v := range l.mem {
		if len(v) > len(all[k]) {
			all[k] = v
		}
	}
	return all
}

// Check refuses when the agent is at its limit.
func (l *CreateLimiter) Check(agentUID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	limit, window := l.limits()
	_, err := CheckCreateRate(l.load()[agentUID], l.now().UnixMilli(), limit, window)
	return err
}

// Record counts one creation by the agent.
func (l *CreateLimiter) Record(agentUID string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	limit, window := l.limits()
	all := l.load()
	now := l.now().UnixMilli()
	kept, _ := CheckCreateRate(all[agentUID], now, limit+1, window)
	all[agentUID] = append(kept, now)
	if l.mem == nil {
		l.mem = map[string][]int64{}
	}
	l.mem[agentUID] = all[agentUID]
	if l.Path == "" {
		return
	}
	if b, err := json.Marshal(all); err == nil {
		_ = os.MkdirAll(filepath.Dir(l.Path), 0o700)
		tmp := l.Path + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, l.Path)
		}
	}
}
