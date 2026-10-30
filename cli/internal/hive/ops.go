package hive

import (
	"context"
	"fmt"
	"strings"
	"time"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/store"
)

// ---------- whoami ----------

// Who is whoami's answer.
type Who struct {
	AgentUID     string             `json:"agentUid"`
	Name         string             `json:"name"`
	WorkspaceID  string             `json:"workspaceId"`
	Paused       bool               `json:"paused"`
	PausedReason *string            `json:"pausedReason"`
	Guardrails   actions.Guardrails `json:"guardrails"`
}

// PermissionsDocs is where Claude Code permissions are explained.
const PermissionsDocs = "https://docs.claude.com/en/docs/claude-code/iam"

// Text is the plain-text form.
func (w Who) Text() string {
	lines := []string{
		fmt.Sprintf("%s (%s) in organization %s", w.Name, w.AgentUID, w.WorkspaceID),
		"work: Inbox threads (projects were removed from Hivenod)",
		"Permissions: your Claude Code settings (~/.claude/settings.json), see " + PermissionsDocs,
	}
	if w.Paused {
		r := ""
		if w.PausedReason != nil && *w.PausedReason != "" {
			r = ": " + *w.PausedReason
		}
		lines = append(lines, "PAUSED"+r+". An admin resumes it in Hivenod.")
	}
	return strings.Join(lines, "\n")
}

// Whoami reads the agent again and describes it.
func (c *Client) Whoami(ctx context.Context) (Who, error) {
	a, err := c.RefreshAgent(ctx)
	if err != nil {
		return Who{}, err
	}
	return Who{AgentUID: c.UID, Name: a.Name, WorkspaceID: c.WorkspaceID, Paused: actions.IsPaused(a), PausedReason: a.PausedReason, Guardrails: actions.GuardrailsOf(a)}, nil
}

// listenQuery delivers every snapshot of q until ctx ends. The Go client resumes broken streams
// itself; when a stream still ends with an error, or the connection comes back after a break
// (recon), it listens again at once (a full resync). Permission-denied is reported and ends it.
func listenQuery(ctx context.Context, recon *store.Reconnects, q firestore.Query, on func([]*firestore.DocumentSnapshot), onErr func(error)) {
	listenLoop(ctx, recon, func(lctx context.Context) error {
		it := q.Snapshots(lctx)
		defer it.Stop()
		for {
			snap, err := it.Next()
			if err != nil {
				return err
			}
			if docs, err := snap.Documents.GetAll(); err == nil {
				on(docs)
			}
		}
	}, onErr)
}

// listenLoop runs one listener (listen returns when its stream ends) with restarts.
func listenLoop(ctx context.Context, recon *store.Reconnects, listen func(context.Context) error, onErr func(error)) {
	backoff := time.Second
	for ctx.Err() == nil {
		var next <-chan struct{}
		if recon != nil {
			next = recon.Next()
		}
		lctx, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- listen(lctx) }()
		var err error
		reconnected := false
		select {
		case err = <-done:
		case <-next:
			reconnected = true
			cancel()
			<-done
		}
		cancel()
		if ctx.Err() != nil {
			return
		}
		if reconnected {
			backoff = time.Second
			continue
		}
		if Denied(err) {
			if onErr != nil {
				onErr(err)
			}
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		case <-next:
		}
		backoff = min(backoff*2, 10*time.Second)
	}
}
