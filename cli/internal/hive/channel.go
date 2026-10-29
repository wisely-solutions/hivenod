package hive

import (
	"context"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// Channel mode of `hivenod mcp` (packages/agent/src/channel.ts): a live Claude Code session as a
// Hivenod agent. Work is pushed in as notifications/claude/channel events, claimed for the
// session, up to MaxItems at a time; notes, answers and stops on the held items are pushed too.

// MaxItemsLimit is the highest max_items accepted.
const MaxItemsLimit = 10

// ChannelClaimMessage refuses claim in a channel session that gets handovers.
const ChannelClaimMessage = `In this session Hivenod hands work over to you already claimed (one at a time, or up to max_items): wait for the next <channel kind="work"> event instead of claiming.`

// Event is one channel notification.
type Event struct {
	Content string            `json:"content"`
	Meta    map[string]string `json:"meta"`
}

// ChannelOptions configure a session.
type ChannelOptions struct {
	ProjectID string
	StepID    string
	MaxItems  int
	Presence  time.Duration    // default 60 s
	Retry     time.Duration    // default 30 s
	Now       func() time.Time // the clock (tests); default the server's (Client.ServerNow)
	ParkCheck time.Duration    // how often parked items are checked for the 24 h return (default 60 s)
	// Inbox events (item 4PEHr, inboxfeed.go): outside MaxItems. Inbox.MaxInbox -1 is the
	// default (3); 0 turns them off.
	Inbox InboxOptions
	// StatusCheck: how often held items are checked for a due status event (item AzveC; default 60 s).
	StatusCheck time.Duration
	// StatusMinute: the length of a minute for the status interval (tests shorten it; default 60 s).
	StatusMinute time.Duration
}

// StatusEveryRefresh: a project's status interval is read again after this long (item AzveC).
const StatusEveryRefresh = 5 * time.Minute

// ParkNote is what park adds to its result (item QjTTL; the same text as the TypeScript CLI).
const ParkNote = `Parked: it stays yours but no longer counts toward max_items, so the next item may arrive. Any tool call on it, or a person's note, answer or Stop, makes it active again. After 24 h without activity it goes back to the queue.`

// GiveBackSkip: an item this session just gave back (release, end_run) is not handed to it again
// for this long (item QjTTL), so the next oldest item gets its turn.
const GiveBackSkip = 10 * time.Minute

// Handover is what the session holds.
type Handover struct {
	ItemID, ProjectID, RunID, Title string
}

type heldItem struct {
	Handover
	cancel context.CancelFunc
	// parked by the agent (item QjTTL): held, but not counted toward MaxItems. Guarded by s.mu.
	parked *parkState
	// wakeMu: one unpark write at a time.
	wakeMu sync.Mutex
	// Status checks (item AzveC), guarded by s.mu: the latest item snapshot, when the next periodic
	// status event is due (zero: never), and the newest person's ask already pushed.
	item      *model.Item
	seen      bool
	statusDue time.Time
	askSeen   time.Time
}

type everyState struct {
	min int64
	at  time.Time
}

type parkState struct {
	reason string
	at     time.Time
}

// Session is a channel session.
type Session struct {
	c    *Client
	cfg  Config
	push func(Event)
	o    ChannelOptions

	contended    int // claims lost to other agents, recently (item lkkyB): widens the fair-pick window
	mu           sync.Mutex
	current      []*heldItem // hand-over order
	stoppedItems map[string]string
	stoppedRuns  map[string]bool
	givenBack    map[string]time.Time  // items given back, with when (item QjTTL)
	every        map[string]everyState // status interval per project (item AzveC)
	closed       bool
	looking      bool
	waking       bool
	lastInfo     string
	Busy         bool
	ctx          context.Context
	cancel       context.CancelFunc
	stopOnce     sync.Once
	// The inbox events of this session (nil when off, busy, or before Start).
	Inbox *InboxFeed
}

// NewSession makes a session; Start begins it.
func NewSession(c *Client, cfg Config, push func(Event), o ChannelOptions) *Session {
	if o.MaxItems < 1 {
		o.MaxItems = 1
	}
	if o.MaxItems > MaxItemsLimit {
		o.MaxItems = MaxItemsLimit
	}
	if o.Presence == 0 {
		o.Presence = 60 * time.Second
	}
	if o.Retry == 0 {
		o.Retry = 30 * time.Second
	}
	if o.Now == nil {
		// The server's clock (park times are server times).
		o.Now = time.Now
		if c != nil {
			o.Now = c.ServerNow
		}
	}
	if o.ParkCheck == 0 {
		o.ParkCheck = 60 * time.Second
	}
	if o.StatusCheck == 0 {
		o.StatusCheck = 60 * time.Second
	}
	if o.StatusMinute == 0 {
		o.StatusMinute = time.Minute
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Session{c: c, cfg: cfg, push: push, o: o, stoppedItems: map[string]string{}, stoppedRuns: map[string]bool{}, givenBack: map[string]time.Time{}, every: map[string]everyState{}, ctx: ctx, cancel: cancel}
}

// active is how many held items are being worked (not parked): what MaxItems counts. Call with
// s.mu held.
func (s *Session) active() int {
	n := 0
	for _, h := range s.current {
		if h.parked == nil {
			n++
		}
	}
	return n
}

// IsParked: this session holds the item and it is parked.
func (s *Session) IsParked(itemID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.byItem(itemID)
	return h != nil && h.parked != nil
}

// Park parks a held item (item QjTTL): it stays claimed but no longer counts toward MaxItems,
// so the next item may be handed over.
func (s *Session) Park(ctx context.Context, itemID, reason, projectID string) (ParkOut, error) {
	s.mu.Lock()
	h := s.byItem(itemID)
	s.mu.Unlock()
	if h == nil {
		return ParkOut{}, Errf(fmt.Sprintf("This session does not hold item %s, so park refuses it.", itemID))
	}
	if projectID == "" {
		projectID = h.ProjectID
	}
	out, err := s.c.Park(ctx, itemID, reason, projectID)
	if err != nil {
		return ParkOut{}, err
	}
	if s.isHeld(h) {
		s.mu.Lock()
		if h.parked == nil { // the item's snapshot may have brought the server's time already
			h.parked = &parkState{reason: out.Parked["reason"], at: s.o.Now()}
		}
		s.mu.Unlock()
		s.look()
	}
	out.Note = ParkNote
	return out, nil
}

// WakeItem: a parked held item is active again (any tool call on it, a person's note or answer).
func (s *Session) WakeItem(ctx context.Context, itemID string) error {
	s.mu.Lock()
	h := s.byItem(itemID)
	s.mu.Unlock()
	if h == nil {
		return nil
	}
	h.wakeMu.Lock()
	defer h.wakeMu.Unlock()
	s.mu.Lock()
	parked := h.parked != nil
	s.mu.Unlock()
	if !parked {
		return nil
	}
	if err := s.c.Unpark(ctx, h.ItemID, h.ProjectID); err != nil {
		return err
	}
	s.mu.Lock()
	h.parked = nil
	s.mu.Unlock()
	return nil
}

// ReturnStale is the 24 h return (item QjTTL): a parked item with no activity for ParkReturn goes
// back to the queue with a note. Activity wakes an item, so a parked one has had none since it
// parked. Runs every ParkCheck; tests call it with a fake clock.
func (s *Session) ReturnStale(ctx context.Context) []string {
	s.mu.Lock()
	var due []*heldItem
	for _, h := range s.current {
		if h.parked != nil && s.o.Now().Sub(h.parked.at) >= model.ParkReturn {
			due = append(due, h)
		}
	}
	s.mu.Unlock()
	out := []string{}
	for _, h := range due {
		s.mu.Lock()
		reason := ""
		if h.parked != nil {
			reason = h.parked.reason
		}
		s.mu.Unlock()
		if reason == "" {
			continue
		}
		if _, err := s.c.AddNote(ctx, h.ItemID, fmt.Sprintf("Parked for 24 hours without activity (waiting: %s): back to the queue.", clip(reason, 200)), h.ProjectID); err != nil {
			continue // tried again at the next check
		}
		s.GaveBack(h.ItemID)
		if _, err := s.c.Release(ctx, h.ItemID, h.ProjectID); err != nil {
			s.ForgetGiveBack(h.ItemID)
			continue
		}
		out = append(out, h.ItemID)
		s.end(h)
		s.push(Event{
			Content: fmt.Sprintf(`"%s" (item_id %s) was parked for 24 hours without activity (waiting: %s). It went back to the queue; stop any work on it.`, h.Title, h.ItemID, clip(reason, 200)),
			Meta:    map[string]string{"kind": "info", "code": "returned", "item_id": h.ItemID, "project_id": h.ProjectID},
		})
	}
	return out
}

// StatusText is the content of a status event (item AzveC); why is "interval" or "asked".
func StatusText(itemID, title, why, by string, maxItems int) string {
	head := fmt.Sprintf(`Status check on "%s" (item_id %s).`, clip(title, 200), itemID)
	if why == "asked" {
		if by == "" {
			by = "A person"
		}
		head = fmt.Sprintf(`%s asked for a status on "%s" (item_id %s).`, by, clip(title, 200), itemID)
	}
	how := fmt.Sprintf(`answer with the status tool (itemId="%s", text: one line on where the work stands, pct: a percentage when known), then carry on.`, itemID)
	if maxItems > 1 {
		return head + " Pass it on to the sub-agent working on this item: it should " + how
	}
	return head + " Please " + how
}

// statusEvery is the project's status interval in minutes (0 = off), read again every few minutes.
func (s *Session) statusEvery(ctx context.Context, projectID string) int64 {
	s.mu.Lock()
	hit, ok := s.every[projectID]
	s.mu.Unlock()
	if ok && s.o.Now().Sub(hit.at) < StatusEveryRefresh {
		return hit.min
	}
	min := int64(model.DefaultStatusEvery)
	if ok {
		min = hit.min
	}
	if s.c != nil {
		if v, err := s.c.StatusEvery(ctx, projectID); err == nil {
			min = v
		}
	}
	s.mu.Lock()
	s.every[projectID] = everyState{min: min, at: s.o.Now()}
	s.mu.Unlock()
	return min
}

// worked: a held item being actively worked, not parked nor waiting (item AzveC). Call with s.mu held.
func (s *Session) worked(h *heldItem) bool {
	if h.parked != nil {
		return false
	}
	return h.item == nil || actions.ActivelyWorked(*h.item)
}

// onStatusFields: an item snapshot (item AzveC). A status from the agent resets the clock; a
// person's new "Ask for status" pushes a status event at once.
func (s *Session) onStatusFields(h *heldItem, it *model.Item) {
	s.mu.Lock()
	first := !h.seen
	h.seen = true
	cp := *it
	h.item = &cp
	st := actions.StatusOf(*it)
	if st != nil && !h.statusDue.IsZero() {
		if e, ok := s.every[h.ProjectID]; ok && e.min > 0 {
			if due := st.At.Add(time.Duration(e.min) * s.o.StatusMinute); due.After(h.statusDue) {
				h.statusDue = due
			}
		}
	}
	ask := actions.StatusAskOf(*it)
	if ask == nil || !ask.At.After(h.askSeen) {
		s.mu.Unlock()
		return
	}
	h.askSeen = ask.At
	push := !first && (st == nil || st.At.Before(ask.At)) && s.worked(h)
	s.mu.Unlock()
	if push {
		go s.pushStatus(h, "asked", it.LastEventID, ask.ByUID)
	}
}

func (s *Session) pushStatus(h *heldItem, why, eventID, byUID string) {
	if !s.isHeld(h) {
		return
	}
	by := ""
	if why == "asked" && s.c != nil {
		by = s.c.AskedBy(s.ctx, eventID, byUID)
	}
	s.push(Event{
		Content: StatusText(h.ItemID, h.Title, why, by, s.o.MaxItems),
		Meta:    map[string]string{"kind": "status", "item_id": h.ItemID, "project_id": h.ProjectID, "run_id": h.RunID, "why": why},
	})
}

// StatusChecks is the periodic status check (item AzveC): a status event for each held item being
// actively worked whose interval has passed since its handover or its last status. Runs every
// StatusCheck; tests call it with a fake clock. Returns the items asked.
func (s *Session) StatusChecks(ctx context.Context) []string {
	s.mu.Lock()
	list := append([]*heldItem(nil), s.current...)
	s.mu.Unlock()
	out := []string{}
	for _, h := range list {
		min := s.statusEvery(ctx, h.ProjectID)
		s.mu.Lock()
		if min <= 0 {
			h.statusDue = time.Time{}
			s.mu.Unlock()
			continue
		}
		every := time.Duration(min) * s.o.StatusMinute
		now := s.o.Now()
		if h.statusDue.IsZero() {
			h.statusDue = now.Add(every)
		}
		if h.item != nil {
			if st := actions.StatusOf(*h.item); st != nil && st.At.Add(every).After(h.statusDue) {
				h.statusDue = st.At.Add(every)
			}
		}
		if now.Before(h.statusDue) {
			s.mu.Unlock()
			continue
		}
		// Not while parked or waiting for people: the clock starts again when it is worked.
		h.statusDue = now.Add(every)
		ok := s.worked(h) && s.byRun(h.RunID) == h
		s.mu.Unlock()
		if !ok {
			continue
		}
		out = append(out, h.ItemID)
		s.pushStatus(h, "interval", "", "")
	}
	return out
}

// GaveBack: the agent gave this item back (release, end_run); it is not handed to this session
// again for GiveBackSkip, so other waiting work gets its turn first.
func (s *Session) GaveBack(itemID string) {
	s.mu.Lock()
	s.givenBack[itemID] = s.o.Now()
	s.mu.Unlock()
}

// ForgetGiveBack: the give-back did not happen after all (the tool failed).
func (s *Session) ForgetGiveBack(itemID string) {
	s.mu.Lock()
	delete(s.givenBack, itemID)
	s.mu.Unlock()
}

// skipped: given back by this session less than GiveBackSkip ago. Call with s.mu held.
func (s *Session) skipped(itemID string) bool {
	at, ok := s.givenBack[itemID]
	if !ok {
		return false
	}
	if s.o.Now().Sub(at) < GiveBackSkip {
		return true
	}
	delete(s.givenBack, itemID)
	return false
}

// MaxItems is how many items the session holds at once.
func (s *Session) MaxItems() int { return s.o.MaxItems }

// IsBusy: another live session holds this agent; this one gets no handovers.
func (s *Session) IsBusy() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.Busy
}

// Held lists the held items in hand-over order.
func (s *Session) Held() []Handover {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Handover, len(s.current))
	for i, h := range s.current {
		out[i] = h.Handover
	}
	return out
}

func (s *Session) byItem(itemID string) *heldItem {
	for _, h := range s.current {
		if h.ItemID == itemID {
			return h
		}
	}
	return nil
}

func (s *Session) byRun(runID string) *heldItem {
	for _, h := range s.current {
		if h.RunID == runID {
			return h
		}
	}
	return nil
}

// clip shortens to n UTF-16 units with an ellipsis, like the TypeScript clip().
func clip(s string, n int) string {
	u := utf16.Encode([]rune(s))
	if len(u) <= n {
		return s
	}
	return string(utf16.Decode(u[:n-1])) + "…"
}

// Resolve finds the held item a tool call is about: itemID may be left out while one item is
// held; a run id must be the held item's; an item not held, or one a person stopped, is refused.
func (s *Session) Resolve(tool, itemID, runID string) (Handover, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := func() string {
		parts := make([]string, len(s.current))
		for i, h := range s.current {
			parts[i] = fmt.Sprintf(`%s ("%s")`, h.ItemID, clip(h.Title, 60))
		}
		return strings.Join(parts, ", ")
	}
	if itemID != "" {
		if run, ok := s.stoppedItems[itemID]; ok && s.byItem(itemID) == nil {
			return Handover{}, Errf(fmt.Sprintf("A person stopped the work on item %s (run %s): %s refuses it. Stop working on it and do not redo it.", itemID, run, tool))
		}
	}
	if runID != "" && s.stoppedRuns[runID] && s.byRun(runID) == nil {
		return Handover{}, Errf(fmt.Sprintf("A person stopped the work of run %s: %s refuses it. Stop working on that item and do not redo it.", runID, tool))
	}
	var h *heldItem
	switch {
	case itemID != "":
		h = s.byItem(itemID)
		if h == nil {
			if len(s.current) > 0 {
				return Handover{}, Errf(fmt.Sprintf("This session does not hold item %s, so %s refuses it. Items held now: %s.", itemID, tool, list()))
			}
			return Handover{}, Errf(fmt.Sprintf(`This session holds no item right now, so %s refuses item %s. Wait for the next <channel kind="work"> event.`, tool, itemID))
		}
	case runID != "":
		h = s.byRun(runID)
		if h == nil {
			if len(s.current) > 0 {
				return Handover{}, Errf(fmt.Sprintf("Run %s is not one of this session's open runs, so %s refuses it. Items held now: %s.", runID, tool, list()))
			}
			return Handover{}, Errf(fmt.Sprintf("This session holds no item right now, so %s refuses run %s.", tool, runID))
		}
	case len(s.current) == 1:
		h = s.current[0]
	case len(s.current) == 0:
		return Handover{}, Errf(`This session holds no item right now. Wait for the next <channel kind="work"> event.`)
	default:
		return Handover{}, Errf(fmt.Sprintf("This session holds %d items: pass itemId to %s. Items held now: %s.", len(s.current), tool, list()))
	}
	if runID != "" && runID != h.RunID {
		return Handover{}, Errf(fmt.Sprintf("Run %s is not the open run of item %s (that is %s), so %s refuses it.", runID, h.ItemID, h.RunID, tool))
	}
	return h.Handover, nil
}

// Start checks for another live session, marks the agent online and starts handing over work.
func (s *Session) Start(ctx context.Context) error {
	if _, err := s.c.RefreshAgent(ctx); err != nil {
		return err
	}
	s.c.SyncServerClock(ctx, s.cfg)
	if err := s.c.CheckNoOtherTerminal(); err != nil {
		s.mu.Lock()
		s.Busy = true
		s.mu.Unlock()
		s.info(Message(err)+" One live session per agent: this session gets no handovers from Hivenod. Its tools still work on items you claim yourself.", "busy")
		return nil
	}
	go func() {
		t := time.NewTicker(s.o.Presence)
		defer t.Stop()
		for {
			pctx, cancel := context.WithTimeout(s.ctx, 30*time.Second)
			_ = s.c.MarkSeen(pctx)
			cancel()
			select {
			case <-s.ctx.Done():
				return
			case <-t.C:
			}
		}
	}()
	go func() {
		t := time.NewTicker(s.o.ParkCheck)
		defer t.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-t.C:
				s.ReturnStale(s.ctx)
			}
		}
	}()
	go func() {
		t := time.NewTicker(s.o.StatusCheck)
		defer t.Stop()
		for {
			select {
			case <-s.ctx.Done():
				return
			case <-t.C:
				s.StatusChecks(s.ctx)
			}
		}
	}()
	s.look()
	if s.o.Inbox.MaxInbox != 0 && s.c != nil {
		s.Inbox = NewInboxFeed(s.c.InboxSource(), s.push, s.o.Inbox, s.o.Now)
		s.Inbox.Start()
	}
	return nil
}

// Stop stops listening and tells Hivenod the agent is offline; held items keep their claims.
func (s *Session) Stop() {
	s.stopOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		for _, h := range s.current {
			h.cancel()
		}
		s.current = nil
		busy := s.Busy
		feed := s.Inbox
		s.mu.Unlock()
		if feed != nil {
			feed.Stop()
		}
		s.cancel()
		if !busy {
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			_ = s.c.MarkOffline(ctx)
			cancel()
		}
	})
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

func (s *Session) later(d time.Duration) {
	s.mu.Lock()
	if s.closed || s.waking {
		s.mu.Unlock()
		return
	}
	s.waking = true
	s.mu.Unlock()
	go func() {
		select {
		case <-s.ctx.Done():
			return
		case <-time.After(d):
		}
		s.mu.Lock()
		s.waking = false
		s.mu.Unlock()
		s.look()
	}()
}

// look waits for the next item (while fewer than MaxItems are held) and hands it over.
func (s *Session) look() {
	s.mu.Lock()
	if s.closed || s.Busy || s.active() >= s.o.MaxItems || s.looking {
		s.mu.Unlock()
		return
	}
	s.looking = true
	s.mu.Unlock()
	go func() {
		err := s.next()
		s.mu.Lock()
		s.looking = false
		closed, waking := s.closed, s.waking
		s.mu.Unlock()
		if err != nil && !closed {
			s.info("Hivenod: "+Message(err)+" Trying again shortly.", "error")
			s.later(s.o.Retry)
			return
		}
		// A handover may have ended while this look was busy: look again if there is room.
		if !waking {
			s.look()
		}
	}()
}

func (s *Session) full() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed || s.active() >= s.o.MaxItems // parked items do not count (item QjTTL)
}

func (s *Session) next() error {
	for {
		if s.full() {
			return nil
		}
		r, err := s.c.WaitForWork(s.ctx, Filter{ProjectID: s.o.ProjectID, StepID: s.o.StepID}, 9*time.Minute, func(id string) bool {
			s.mu.Lock()
			defer s.mu.Unlock()
			// Held items are listed as "claimed by you": not new work. Nor is an item just given
			// back (the wait re-checks every 30 s, so it returns after the skip).
			return s.byItem(id) != nil || s.skipped(id)
		})
		if s.ctx.Err() != nil {
			return nil
		}
		if err != nil {
			return err
		}
		if r.TimedOut {
			continue
		}
		rows := make([]WorkRow, 0, len(r.Work))
		s.mu.Lock()
		for _, row := range r.Work {
			if s.byItem(row.ItemID) == nil && !s.skipped(row.ItemID) {
				rows = append(rows, row)
			}
		}
		s.mu.Unlock()
		// Oldest first (the client's order); items this agent already holds first (a session that
		// restarted resumes them).
		sort.SliceStable(rows, func(i, j int) bool {
			mi := rows[i].Claim != nil && rows[i].Claim.Mine
			mj := rows[j].Claim != nil && rows[j].Claim.Mine
			return mi && !mj
		})
		rows = s.fairOrder(rows)
		handed := false
		for _, row := range rows {
			if s.full() {
				break
			}
			ok, err := s.handOver(row)
			if err != nil {
				return err
			}
			if ok {
				handed = true
			}
		}
		if handed {
			continue
		}
		s.later(2 * time.Second)
		return nil
	}
}

// WorkText is the content of a work event.
func WorkText(row WorkRow, why Arrival, maxItems int) string {
	var lines []string
	if row.Job != nil && *row.Job == "shape" {
		lines = append(lines, fmt.Sprintf(`New item to shape in %s: "%s". Choose the steps it needs (read_item, then shape_item); do not do its work.`, row.Project, row.Title))
	} else {
		lines = append(lines, fmt.Sprintf(`New work in %s, step %s: "%s".`, row.Project, row.Step, row.Title))
	}
	if why.Why == "sent_back" {
		lines = append(lines, fmt.Sprintf("It was sent back to this step by %s. The reason: %s", why.By, clip(why.Text, 3000)))
	}
	if why.Why == "answered" {
		if why.HasQ && why.Question != "" {
			lines = append(lines, "Your question: "+clip(why.Question, 1500))
		}
		lines = append(lines, fmt.Sprintf("%s answered: %s", why.By, clip(why.Text, 3000)))
	}
	if maxItems <= 1 {
		lines = append(lines, "It is claimed for you. Start with read_item.")
		return strings.Join(lines, "\n")
	}
	id := row.ItemID
	if id == "" {
		id = "?"
	}
	finish := ", then finish with complete (or send_back, ask or release)"
	if row.Job != nil && *row.Job == "shape" {
		finish = " (shape it with shape_item; do not do its work)"
	}
	lines = append(lines, fmt.Sprintf(`It is claimed for you (item_id %s). Run it in a new background sub-agent of its own, with this brief: "You work Hivenod item %s. Pass itemId="%s" to every hivenod tool. Start with read_item, do what the step needs%s, and report back in one line." Stay free for the next event.`, id, id, id, finish))
	return strings.Join(lines, "\n")
}

func (s *Session) handOver(row WorkRow) (bool, error) {
	why := s.c.ArrivalOf(s.ctx, row.ItemID, row.ProjectID)
	// The first status check is due one interval after the handover (item AzveC).
	min := s.statusEvery(s.ctx, row.ProjectID)
	claimed, err := s.c.Claim(s.ctx, row.ItemID, row.ProjectID)
	if err != nil {
		var he *Error
		if errors.As(err, &he) {
			if IsTaken(err) {
				s.noteContention(true)
			}
			return false, nil // taken, held or limited meanwhile
		}
		if s.ctx.Err() != nil {
			return false, nil
		}
		return false, err
	}
	s.noteContention(false)
	hctx, cancel := context.WithCancel(s.ctx)
	h := &heldItem{Handover: Handover{ItemID: row.ItemID, ProjectID: row.ProjectID, RunID: claimed.RunID, Title: row.Title}, cancel: cancel}
	if min > 0 {
		h.statusDue = s.o.Now().Add(time.Duration(min) * s.o.StatusMinute)
	}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		cancel()
		return false, nil
	}
	s.lastInfo = ""
	s.current = append(s.current, h)
	delete(s.stoppedItems, h.ItemID) // a new handover of a stopped item (after Resume) works again
	holding, parked := s.active(), len(s.current)-s.active()
	s.mu.Unlock()
	s.c.WatchItem(hctx, row.ProjectID, row.ItemID, func(it *model.Item) { s.onItem(h, it) })
	s.c.WatchRun(hctx, claimed.RunID, func(r model.Run) {
		by := ""
		if r.StoppedBy != nil {
			by = r.StoppedBy.Name
		}
		s.reportStop(h, by, str(r.Summary))
	})
	s.c.WatchNewMessages(hctx, row.ProjectID, row.ItemID, func(m NewMessage) { s.onMessage(h, m) })
	meta := map[string]string{
		"kind": "work", "item_id": row.ItemID, "project_id": row.ProjectID, "run_id": claimed.RunID,
		"step_id": row.StepID, "step": row.Step, "project": row.Project, "why": why.Why,
	}
	if claimed.Resumed {
		meta["resumed"] = "true"
	}
	if s.o.MaxItems > 1 {
		meta["max_items"] = strconv.Itoa(s.o.MaxItems)
		meta["holding"] = strconv.Itoa(holding)
	}
	if parked > 0 {
		meta["parked"] = strconv.Itoa(parked)
	}
	s.push(Event{Content: WorkText(row, why, s.o.MaxItems), Meta: meta})
	return true, nil
}

// maxContention bounds the fair-pick window: at most this many oldest rows are spread over.
const maxContention = 8

// noteContention adapts the fair pick (item lkkyB): a claim lost to another agent widens the window
// the agent spreads over by one; a claim won narrows it. A lone agent never loses, so it stays at
// strict oldest-first.
func (s *Session) noteContention(lost bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if lost && s.contended < maxContention-1 {
		s.contended++
	} else if !lost && s.contended > 0 {
		s.contended--
	}
}

// fairOrder puts the rows in the order this session tries them. Items this agent holds come first;
// then the oldest 1+contended waiting rows are tried in an order that depends on this agent and the
// item (so several agents on one step do not all race for the head item); the rest stay oldest-first.
func (s *Session) fairOrder(rows []WorkRow) []WorkRow {
	s.mu.Lock()
	w := 1 + s.contended
	s.mu.Unlock()
	return fairPick(rows, s.c.UID, w)
}

// fairPick: rows are oldest-first with own items first. The first window of not-held rows is
// reordered by a hash of (agent, item); w <= 1 keeps strict oldest-first.
func fairPick(rows []WorkRow, agent string, w int) []WorkRow {
	mine := 0
	for mine < len(rows) && rows[mine].Claim != nil && rows[mine].Claim.Mine {
		mine++
	}
	rest := rows[mine:]
	if w > len(rest) {
		w = len(rest)
	}
	if w <= 1 {
		return rows
	}
	out := append([]WorkRow{}, rows[:mine]...)
	head := append([]WorkRow{}, rest[:w]...)
	sort.SliceStable(head, func(i, j int) bool {
		return pickRank(agent, head[i].ItemID) < pickRank(agent, head[j].ItemID)
	})
	out = append(out, head...)
	return append(out, rest[w:]...)
}

func pickRank(agent, item string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(agent + "/" + item))
	return h.Sum32()
}

func (s *Session) isHeld(h *heldItem) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.byRun(h.RunID) == h
}

// onItem: the handover ends when the item no longer has this run's claim.
func (s *Session) onItem(h *heldItem, it *model.Item) {
	if !s.isHeld(h) {
		return
	}
	if it != nil && it.Claim != nil && it.Claim.RunID == h.RunID {
		s.onStatusFields(h, it)
		// Keep the park in step with the item (a resumed parked item, or another process of ours).
		if h.wakeMu.TryLock() {
			pk := actions.ParkOf(*it)
			s.mu.Lock()
			newly := false
			if pk != nil {
				// The server's time and reason (a resumed parked item, or a park just written).
				newly = h.parked == nil
				h.parked = &parkState{reason: pk.Reason, at: pk.At}
			} else if h.parked != nil {
				h.parked = nil
			}
			s.mu.Unlock()
			h.wakeMu.Unlock()
			if newly {
				s.look()
			}
		}
		return
	}
	if it != nil && it.WorkStopped != nil && it.WorkStopped.RunID == h.RunID {
		s.reportStop(h, "", it.WorkStopped.Reason)
		return
	}
	s.end(h)
}

func (s *Session) reportStop(h *heldItem, by, reason string) {
	s.mu.Lock()
	if s.byRun(h.RunID) != h {
		s.mu.Unlock()
		return
	}
	s.stoppedItems[h.ItemID] = h.RunID
	s.stoppedRuns[h.RunID] = true
	s.mu.Unlock()
	s.end(h)
	if by == "" {
		by = "A person"
	}
	r := ""
	if reason != "" {
		r = ": " + clip(reason, 500)
	}
	others := ""
	if s.o.MaxItems > 1 {
		others = " (stop the sub-agent working on this item only; the others go on)"
	}
	s.push(Event{
		Content: fmt.Sprintf(`%s stopped your work on "%s" (item_id %s) in Hivenod%s. Stop working on it now%s and do not redo it; its run has ended.`, by, h.Title, h.ItemID, r, others),
		Meta:    map[string]string{"kind": "stop", "item_id": h.ItemID, "project_id": h.ProjectID, "run_id": h.RunID},
	})
}

func (s *Session) end(h *heldItem) {
	s.mu.Lock()
	idx := -1
	for i, x := range s.current {
		if x == h {
			idx = i
		}
	}
	if idx < 0 {
		s.mu.Unlock()
		return
	}
	s.current = append(s.current[:idx], s.current[idx+1:]...)
	s.mu.Unlock()
	h.cancel()
	s.c.UntrackRun(h.RunID)
	s.look()
}

func (s *Session) onMessage(h *heldItem, m NewMessage) {
	if !s.isHeld(h) || m.Message.By.Type != "human" {
		return
	}
	// Stop work also leaves its reason as a note, in the same batch: let the stop win.
	if m.Message.Kind == "note" {
		time.Sleep(400 * time.Millisecond)
	}
	if !s.isHeld(h) {
		return
	}
	// A person's note or answer wakes a parked item (item QjTTL); the event still goes out.
	if m.Message.Kind == "note" || m.Message.Kind == "answer" {
		_ = s.WakeItem(s.ctx, h.ItemID)
	}
	tag := ""
	if s.o.MaxItems > 1 {
		tag = " (item_id " + h.ItemID + ")"
	}
	meta := map[string]string{"item_id": h.ItemID, "project_id": h.ProjectID, "run_id": h.RunID}
	switch m.Message.Kind {
	case "note":
		meta["kind"] = "note"
		s.push(Event{Content: fmt.Sprintf(`A person left a note on "%s"%s: %s`, h.Title, tag, clip(m.Message.Text, 4000)), Meta: meta})
	case "answer":
		meta["kind"] = "answer"
		q := ""
		if m.Question != nil {
			q = "Your question: " + clip(*m.Question, 1500) + "\n"
		}
		s.push(Event{Content: fmt.Sprintf(`%sA person answered on "%s"%s: %s`, q, h.Title, tag, clip(m.Message.Text, 4000)), Meta: meta})
	}
}

// AskAndHold: in channel mode ask on a handed-over item also ends the run and holds the item
// for the answer (it comes back as new work with the answer).
func (s *Session) AskAndHold(ctx context.Context, itemID, question, projectID string) (any, error) {
	asked, err := s.c.Ask(ctx, itemID, question, projectID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	h := s.byItem(itemID)
	s.mu.Unlock()
	if h == nil {
		return asked, nil
	}
	if _, err := s.c.ReleaseRun(ctx, h.RunID, "", asked.MessageID, Outcome{}); err != nil {
		return nil, err
	}
	return AskOut{MessageID: asked.MessageID, Note: `The question shows under "Needs you" in Hivenod. The item waits for the answer and comes back to you with it as new work. Your run on it has ended; the next item may arrive meanwhile.`}, nil
}
