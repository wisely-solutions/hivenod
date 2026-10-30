package main

import (
	"context"
	"io"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/hive"
	"github.com/wisely-solutions/hivenod/cli/internal/mcpserver"
	"github.com/wisely-solutions/hivenod/cli/internal/update"
)

// MaxItemsLimit is the highest max_items accepted.
const MaxItemsLimit = 10

// parseMaxItems reads --max-items / HIVENOD_MAX_ITEMS: a whole number 1..10, or 0 when unset.
func parseMaxItems(v, from string) (int, error) {
	if strings.TrimSpace(v) == "" {
		return 0, nil
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || n != float64(int(n)) || n < 1 || n > MaxItemsLimit {
		return 0, hive.Errf(from + " must be a whole number from 1 to " + strconv.Itoa(MaxItemsLimit) + ` (got "` + v + `").`)
	}
	return int(n), nil
}

// parseMaxInbox reads --max-inbox / HIVENOD_MAX_INBOX: a whole number 0..10, or -1 when unset.
func parseMaxInbox(v, from string) (int, error) {
	if strings.TrimSpace(v) == "" {
		return -1, nil
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || n != float64(int(n)) || n < 0 || n > hive.MaxInboxLimit {
		return 0, hive.Errf(from + " must be a whole number from 0 to " + strconv.Itoa(hive.MaxInboxLimit) + ` (got "` + v + `").`)
	}
	return int(n), nil
}

func runMCP(ctx context.Context, cfg hive.Config, o opts, stdin io.Reader, stdout io.Writer) error {
	if !o.channel {
		tok, _, err := credentials.Resolve()
		if err != nil {
			return hive.Errf(credentials.DamagedMessage())
		}
		if tok == "" {
			return hive.Errf(hive.NotPairedMessage)
		}
	}
	flag, err := parseMaxItems(o.maxItems, "--max-items")
	if err != nil {
		return err
	}
	if flag != 0 && !o.channel {
		return hive.Errf("--max-items needs hivenod mcp --channel.")
	}
	maxInbox, err := parseMaxInbox(o.maxInbox, "--max-inbox")
	if err != nil {
		return err
	}
	if o.maxInbox != "" && !o.channel {
		return hive.Errf("--max-inbox needs hivenod mcp --channel.")
	}
	if maxInbox < 0 {
		if maxInbox, err = parseMaxInbox(os.Getenv("HIVENOD_MAX_INBOX"), "HIVENOD_MAX_INBOX"); err != nil {
			return err
		}
	}
	// Tests only: a short heartbeat interval (black-box suite in cli/e2e).
	if d := msEnv("HIVENOD_HEARTBEAT_MS"); d > 0 {
		hive.HeartbeatInterval = d
	}
	lazy := &hive.Lazy{Connect: func(ctx context.Context) (*hive.Client, error) { return hive.Connect(ctx, cfg, "") }}
	sf := mcpserver.LoadSurface()
	srv := &mcpserver.Server{Info: sf.ServerInfo}
	var cs *hive.ChannelServer
	var session *hive.Session
	var sessMu sync.Mutex
	if !o.channel {
		srv.Capabilities = sf.Plain.Capabilities
		srv.Tools = hive.PlainTools(lazy)
	} else {
		maxItems := flag
		if maxItems == 0 {
			if maxItems, err = parseMaxItems(os.Getenv("HIVENOD_MAX_ITEMS"), "HIVENOD_MAX_ITEMS"); err != nil {
				return err
			}
		}
		if maxItems == 0 {
			maxItems = 1
		}
		cs = &hive.ChannelServer{}
		srv.Capabilities = sf.Channel.Capabilities
		srv.Instructions = hive.ChannelInstructions(maxItems)
		srv.Tools = hive.ChannelTools(lazy, cs)
		push := func(e hive.Event) { _ = srv.Notify("notifications/claude/channel", e) }
		opts := hive.ChannelOptions{ProjectID: o.project, StepID: o.step, MaxItems: maxItems,
			Presence: msEnv("HIVENOD_PRESENCE_MS"), Retry: msEnv("HIVENOD_CHANNEL_RETRY_MS"),
			ParkCheck: msEnv("HIVENOD_PARK_CHECK_MS"), StatusCheck: msEnv("HIVENOD_STATUS_CHECK_MS"),
			StatusMinute: msEnv("HIVENOD_STATUS_MINUTE_MS"),
			Inbox: hive.InboxOptions{MaxInbox: maxInbox, MaxSteps: maxItems, PerMinute: int(msEnv("HIVENOD_INBOX_PER_MIN") / time.Millisecond),
				NudgeAfter: msEnv("HIVENOD_INBOX_NUDGE_MS"), Lease: msEnv("HIVENOD_INBOX_LEASE_MS"), Tick: msEnv("HIVENOD_INBOX_TICK_MS")}}
		if cfg.WebURL != "" && os.Getenv("HIVENOD_NO_UPDATE_CHECK") == "" {
			u := &update.Updater{Site: cfg.WebURL}
			opts.UpdateNotice = func(c context.Context) string { return u.Notice(c, credentials.Home(), time.Now()) }
		}
		srv.OnInitialized = func() {
			c, err := lazy.Get(ctx)
			if err == nil {
				s := hive.NewSession(c, cfg, push, opts)
				if err = s.Start(ctx); err == nil {
					sessMu.Lock()
					session = s
					sessMu.Unlock()
					cs.Set(s)
					return
				}
			}
			// Never started: its tools pass calls through as without a channel.
			push(hive.Event{Content: "Hivenod could not start handing work to this session: " + hive.Message(err) + " Fix it, then restart the session.", Meta: map[string]string{"kind": "info", "code": "setup"}})
		}
	}
	err = srv.Serve(ctx, stdin, stdout)
	// A clean end (stdin closed, SIGINT/SIGTERM/SIGHUP) writes offline at once; only a crash is
	// left to the presence timeout. Capped so a hung network cannot keep the process up.
	done := make(chan struct{})
	go func() {
		sessMu.Lock()
		s := session
		sessMu.Unlock()
		if s != nil {
			s.Stop()
		}
		if c := lazy.Current(); c != nil {
			c.Close()
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
	}
	return err
}

// msEnv reads a duration in milliseconds from the environment (tests); 0 when unset.
func msEnv(k string) time.Duration {
	n, err := strconv.Atoi(os.Getenv(k))
	if err != nil || n <= 0 {
		return 0
	}
	return time.Duration(n) * time.Millisecond
}
