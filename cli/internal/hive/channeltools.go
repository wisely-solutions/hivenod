package hive

import (
	"sync"

	"github.com/wisely-solutions/hivenod/cli/internal/mcpserver"
)

// ChannelServer is the shared state of `hivenod mcp --channel`: the session once started.
type ChannelServer struct {
	mu      sync.Mutex
	session *Session
}

// Set records the started session (nil: never started).
func (cs *ChannelServer) Set(s *Session) {
	cs.mu.Lock()
	cs.session = s
	cs.mu.Unlock()
}

// Get is the session, or nil.
func (cs *ChannelServer) Get() *Session {
	cs.mu.Lock()
	defer cs.mu.Unlock()
	return cs.session
}

// ChannelTools are the tools of a channel session. Since projects were removed (slice 11) they
// are all thread tools and work the same as without a channel.
func ChannelTools(lazy *Lazy, _ *ChannelServer) []mcpserver.Tool {
	return tools(lazy, mcpserver.LoadSurface().Channel.Tools)
}
