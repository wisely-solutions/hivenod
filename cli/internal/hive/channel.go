package hive

import (
	"context"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
)

// Channel mode of `hivenod mcp` (ported from the former TypeScript channel.ts): a live Claude Code
// session as a Hivenod agent. Projects were removed from Hivenod (item OE8FmrTaIxFVGcaeGG3N,
// slice 11): work arrives as Inbox threads only (inboxfeed.go). The session keeps the agent's
// presence (one live session per agent) and pushes info events.

// MaxItemsLimit is the highest max_items (long plan steps at once) accepted.
const MaxItemsLimit = 10

// ProjectsRemovedMessage answers whatever looked for project work (create-item, --project/--step).
const ProjectsRemovedMessage = "Projects were removed from Hivenod; work arrives as Inbox threads."

// Event is one channel notification.
type Event struct {
	Content string            `json:"content"`
	Meta    map[string]string `json:"meta"`
}

// ChannelOptions configure a session.
type ChannelOptions struct {
	Presence time.Duration    // default 60 s
	Now      func() time.Time // the clock (tests); default the server's (Client.ServerNow)
	// Inbox events (item 4PEHr, inboxfeed.go). Inbox.MaxInbox -1 is the default (3); 0 turns
	// them off. Inbox.MaxSteps is --max-items: long plan steps run at once.
	Inbox InboxOptions
	// UpdateNotice returns a text when a newer hivenod exists ("" otherwise); the session tells
	// it once as an info event (item N9EEn). Nil: no check.
	UpdateNotice func(ctx context.Context) string
}

// Session is a channel session.
type Session struct {
	c    *Client
	cfg  Config
	push func(Event)
	o    ChannelOptions

	mu       sync.Mutex
	closed   bool
	lastInfo string
	Busy     bool
	ctx      context.Context
	cancel   context.CancelFunc
	stopOnce sync.Once
	// The inbox events of this session (nil when off, busy, or before Start).
	Inbox *InboxFeed
}

// NewSession makes a session; Start begins it.
func NewSession(c *Client, cfg Config, push func(Event), o ChannelOptions) *Session {
	if o.Presence == 0 {
		o.Presence = 60 * time.Second
	}
	if o.Now == nil {
		o.Now = time.Now
		if c != nil {
			o.Now = c.ServerNow
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{c: c, cfg: cfg, push: push, o: o, ctx: ctx, cancel: cancel}
}

// IsBusy: another live session of this agent holds the work.
func (s *Session) IsBusy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Busy
}

// Start checks for another live session, marks the agent online and starts the Inbox events.
func (s *Session) Start(ctx context.Context) error {
	if _, err := s.c.RefreshAgent(ctx); err != nil {
		return err
	}
	s.c.SyncServerClock(ctx, s.cfg)
	// Item N0biX: an earlier session of this agent on this machine (a restart after a crash) is
	// taken over at once; one on another machine still makes this session busy.
	if sid, _ := s.c.PresenceIdentity(); sid == "" {
		s.c.SetPresenceIdentity(NewSessionID(), HostID())
	}
	decision, live := s.c.StartDecision()
	switch decision {
	case actions.PresenceBusy:
		err := s.c.CheckNoOtherTerminal()
		if err == nil { // the clock moved on between the two reads
			break
		}
		s.mu.Lock()
		s.Busy = true
		s.mu.Unlock()
		s.info(Message(err)+" One live session per agent: this session gets no Inbox events from Hivenod. Its tools still work.", "busy")
		go s.watchBusy(s.ctx, s.recheckPresence, s.o.Presence, func(dec string, live *actions.Terminal) {
			s.mu.Lock()
			if s.closed {
				s.mu.Unlock()
				return
			}
			s.Busy = false
			s.mu.Unlock()
			s.info("The other session of this agent stopped: this session gets the Inbox events now.", "takeover")
			s.begin()
		})
		return nil
	case actions.PresenceTakeOver:
		since := ""
		if live != nil {
			since = " (last seen " + live.Since.Local().Format("3:04:05 PM") + ")"
		}
		s.info("This session took over from an earlier session of this agent on this machine"+since+": it gets the Inbox events now.", "takeover")
	}
	s.begin()
	return nil
}

// recheckPresence reads the agent doc again and decides as Start does.
func (s *Session) recheckPresence(ctx context.Context) (string, *actions.Terminal, bool) {
	pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if _, err := s.c.RefreshAgent(pctx); err != nil {
		return "", nil, false
	}
	dec, live := s.c.StartDecision()
	return dec, live, true
}

// watchBusy re-checks the presence every interval while this session is busy (another live session
// of the agent holds it). When the other session is gone (stale or signed out), it calls onFree once
// and stops. It never fires while the other session is live. It stops when ctx ends.
func (s *Session) watchBusy(ctx context.Context, check func(context.Context) (string, *actions.Terminal, bool), every time.Duration, onFree func(string, *actions.Terminal)) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		dec, live, ok := check(ctx)
		if !ok || dec == actions.PresenceBusy {
			continue
		}
		onFree(dec, live)
		return
	}
}

// begin marks the agent online and starts the Inbox events (the normal start path).
func (s *Session) begin() {
	if s.o.UpdateNotice != nil {
		go func() {
			if msg := s.o.UpdateNotice(s.ctx); msg != "" {
				s.info(msg, "update")
			}
		}()
	}
	go func() {
		t := time.NewTicker(s.o.Presence)
		defer t.Stop()
		for first := true; ; first = false {
			pctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
			// The first stamp is this session's (it may take over); later ones first check that
			// no other session of this agent took over since (item N0biX).
			if !first {
				if over, err := s.c.TakenOver(pctx); err == nil && over {
					cancel()
					s.takenOver()
					return
				}
			}
			_ = s.c.MarkSeen(pctx)
			cancel()
			select {
			case <-s.ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	if s.o.Inbox.MaxInbox != 0 && s.c != nil {
		feed := NewInboxFeed(s.c.InboxSource(), s.push, s.o.Inbox, s.o.Now)
		s.mu.Lock()
		s.Inbox = feed
		s.mu.Unlock()
		feed.Start()
	}
}

// Stop stops listening and tells Hivenod the agent is offline.
func (s *Session) Stop() {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		busy := s.Busy
		feed := s.Inbox
		s.mu.Unlock()
		if feed != nil {
			feed.Stop()
		}
		s.cancel()
		if !busy {
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			// Never mark offline a session that took over from this one (item N0biX).
			if over, err := s.c.TakenOver(ctx); err != nil || !over {
				_ = s.c.MarkOffline(ctx)
			}
			cancel()
		}
	})
}

// TakenOverText is the info event of a session another session of the same agent took over.
const TakenOverText = "Another session of this agent took over on this machine. This session gets no more Inbox events (the new session resumes its threads and running steps): stop working on them."

// takenOver: another session of this agent stamped presence since this one did (item N0biX).
// This one stops taking work; it writes no presence and never marks the
// agent offline.
func (s *Session) takenOver() {
	s.mu.Lock()
	if s.closed || s.Busy {
		s.mu.Unlock()
		return
	}
	s.Busy = true
	feed := s.Inbox
	s.mu.Unlock()
	if feed != nil {
		feed.Stop()
	}
	s.info(TakenOverText, "taken_over")
}

func (s *Session) info(text, code string) {
	s.mu.Lock()
	if text == s.lastInfo {
		s.mu.Unlock()
		return
	}
	s.lastInfo = text
	s.mu.Unlock()
	s.push(Event{Content: text, Meta: map[string]string{"kind": "info", "code": code}})
}

// clip shortens to n UTF-16 units with an ellipsis, like the TypeScript clip().
func clip(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n-1])) + "…"
}
