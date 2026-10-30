package hive

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
)

// ServerNow is the server's clock (local clock plus the measured offset).
func (c *Client) ServerNow() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.clockOffset)
}

// SyncServerClock measures the offset from the Date header of the Firestore endpoint (best
// effort), so "is another terminal alive" compares server time with server time.
func (c *Client) SyncServerClock(ctx context.Context, cfg Config) {
	url := "https://firestore.googleapis.com/"
	if cfg.FSEmulator != "" {
		url = "http://" + cfg.FSEmulator + "/"
	}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(cctx, http.MethodHead, url, nil)
	if err != nil {
		return
	}
	t0 := time.Now()
	res, err := http.DefaultClient.Do(req)
	t1 := time.Now()
	if err != nil {
		return
	}
	res.Body.Close()
	date, err := http.ParseTime(res.Header.Get("Date"))
	if err != nil {
		return
	}
	mid := t0.Add(t1.Sub(t0) / 2)
	c.mu.Lock()
	c.clockOffset = date.Add(500 * time.Millisecond).Sub(mid)
	c.mu.Unlock()
}

// CheckNoOtherTerminal refuses when another terminal of this agent is alive.
func (c *Client) CheckNoOtherTerminal() error {
	t := actions.LiveTerminal(c.Agent(), c.ServerNow().UnixMilli())
	if t == nil {
		return nil
	}
	host := "unknown host"
	if t.Host != nil && *t.Host != "" {
		host = *t.Host
	}
	return Errf(fmt.Sprintf("This agent is already running in another terminal (%s, last seen %s). Stop it first, or create another agent. (If that terminal crashed, try again in 2 minutes.)", host, t.Since.Local().Format("3:04:05 PM")))
}
