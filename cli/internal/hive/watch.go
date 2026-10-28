package hive

import (
	"context"
	"fmt"
	"net/http"
	"time"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/store"
)

// Arrival says why an item is at its step now (channel mode).
type Arrival struct {
	Why      string // arrived | sent_back | answered
	By       string
	Text     string
	Question string
	HasQ     bool
}

// ArrivalOf reads the event that put the item where it is (its lastEventId). Best effort.
func (c *Client) ArrivalOf(ctx context.Context, itemID, projectID string) Arrival {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return Arrival{Why: "arrived"}
	}
	eid := l.Item.LastEventID
	base := "workspaces/" + c.WorkspaceID + "/projects/" + l.ProjectID
	snap, err := c.DB.Doc(model.Paths.Event(c.WorkspaceID, eid)).Get(ctx)
	if err != nil || !snap.Exists() {
		return Arrival{Why: "arrived"}
	}
	var e eventDoc
	if snap.DataTo(&e) != nil {
		return Arrival{Why: "arrived"}
	}
	switch e.Type {
	case "item.sentBack":
		return Arrival{Why: "sent_back", By: e.Actor.Name, Text: strOf(e.Data["reason"])}
	case "decision.sentBack":
		d, err := c.DB.Doc(base + "/decisions/" + eid).Get(ctx)
		text := ""
		if err == nil && d.Exists() {
			text = strOf(d.Data()["rationale"])
		}
		return Arrival{Why: "sent_back", By: e.Actor.Name, Text: text}
	case "decision.answered":
		a, err := c.DB.Doc(base + "/items/" + itemID + "/messages/" + eid).Get(ctx)
		var am map[string]any
		if err == nil && a.Exists() {
			am = a.Data()
		}
		out := Arrival{Why: "answered", By: e.Actor.Name, Text: strOf(am["text"])}
		if rt, ok := am["replyTo"].(string); ok && rt != "" {
			if q, err := c.DB.Doc(base + "/items/" + itemID + "/messages/" + rt).Get(ctx); err == nil && q.Exists() {
				out.Question, out.HasQ = strOf(q.Data()["text"]), true
			}
		}
		return out
	}
	return Arrival{Why: "arrived"}
}

// watchDoc delivers every snapshot of a document until ctx ends or the listener is refused
// (then onEnd), with the same restarts as listenQuery.
func watchDoc(ctx context.Context, recon *store.Reconnects, ref *firestore.DocumentRef, on func(*firestore.DocumentSnapshot), onEnd func(error)) {
	listenLoop(ctx, recon, func(lctx context.Context) error {
		it := ref.Snapshots(lctx)
		defer it.Stop()
		for {
			snap, err := it.Next()
			if err != nil {
				return err
			}
			on(snap)
		}
	}, onEnd)
}

// WatchItem calls onChange with the live item (nil when it is gone or unreadable).
func (c *Client) WatchItem(ctx context.Context, projectID, itemID string, onChange func(*model.Item)) {
	go watchDoc(ctx, c.recon, c.DB.Doc(model.Paths.Item(c.WorkspaceID, projectID, itemID)), func(s *firestore.DocumentSnapshot) {
		if !s.Exists() {
			onChange(nil)
			return
		}
		it, err := model.DecodeItem(s)
		if err != nil {
			return // a shape this client does not know: ignore
		}
		onChange(&it)
	}, func(error) { onChange(nil) })
}

// WatchRun calls onStopped once when a person stops the run.
func (c *Client) WatchRun(ctx context.Context, runID string, onStopped func(model.Run)) {
	fired := false
	go watchDoc(ctx, c.recon, c.DB.Doc(model.Paths.Run(c.WorkspaceID, runID)), func(s *firestore.DocumentSnapshot) {
		var r model.Run
		if fired || !s.Exists() || s.DataTo(&r) != nil {
			return
		}
		if r.Status == "stopped" {
			fired = true
			onStopped(r)
		}
	}, nil)
}

// NewMessage is a message added after the listener started, with the question it answers.
type NewMessage struct {
	ID       string
	Message  model.Message
	Question *string
}

// WatchNewMessages calls onMessage for each message added after the listener starts (the
// ones already there are skipped), also across a resync after a broken stream.
func (c *Client) WatchNewMessages(ctx context.Context, projectID, itemID string, onMessage func(NewMessage)) {
	col := c.DB.Collection("workspaces/" + c.WorkspaceID + "/projects/" + projectID + "/items/" + itemID + "/messages")
	go func() {
		seen := map[string]bool{}
		texts := map[string]string{}
		first := true
		listenQuery(ctx, c.recon, col.Query, func(docs []*firestore.DocumentSnapshot) {
			var added []NewMessage
			for _, d := range docs {
				var m model.Message
				if d.DataTo(&m) != nil {
					continue
				}
				texts[d.Ref.ID] = m.Text
				if !seen[d.Ref.ID] {
					seen[d.Ref.ID] = true
					if !first {
						added = append(added, NewMessage{ID: d.Ref.ID, Message: m})
					}
				}
			}
			first = false
			sortByAt(added, func(x NewMessage) time.Time { return x.Message.At })
			for _, a := range added {
				if a.Message.ReplyTo != nil {
					if t, ok := texts[*a.Message.ReplyTo]; ok {
						a.Question = &t
					}
				}
				onMessage(a)
			}
		}, func(error) {})
	}()
}

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
