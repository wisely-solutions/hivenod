// hivenod-spike: part 1 of the Go CLI (item zLwtX2WEEg3mER4CR74g). Proves, as a signed-in agent
// under firestore.rules: reads, batched writes with server values, live listeners for everything
// channel mode uses, survival of network drops, and ID-token refresh. Not shipped.
//
//	hivenod-spike whoami
//	hivenod-spike read <doc path>
//	hivenod-spike apply            (plan JSON on stdin)
//	hivenod-spike listen [-projects p1,p2] [-presence 60s] [-duration 2h]
//
// Env: HIVENOD_TOKEN, HIVENOD_PROJECT_ID, FIREBASE_AUTH_EMULATOR_HOST, FIRESTORE_EMULATOR_HOST,
// HIVENOD_FIREBASE_API_KEY, HIVENOD_SPIKE_DIAL (dial this address instead, e.g. a flaky forwarder).
// Output: one JSON object per line on stdout.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/wisely-solutions/hivenod/cli/internal/auth"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
	"github.com/wisely-solutions/hivenod/cli/internal/store"
	"github.com/wisely-solutions/hivenod/cli/internal/token"
)

const defaultAPIKey = "AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4"
const defaultProject = "hive-board-43be"

var outMu sync.Mutex

func emit(kind string, f map[string]any) {
	f["t"] = time.Now().UnixMilli()
	f["kind"] = kind
	b, _ := json.Marshal(f)
	outMu.Lock()
	os.Stdout.Write(append(b, '\n'))
	outMu.Unlock()
}

func env(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

type agentConn struct {
	sess *auth.Session
	db   *firestore.Client
	ws   string
}

func connect(ctx context.Context) (*agentConn, error) {
	parts, err := token.Decode(os.Getenv("HIVENOD_TOKEN"))
	if err != nil {
		return nil, err
	}
	sess, err := auth.SignIn(ctx, auth.Config{
		APIKey:   env("HIVENOD_FIREBASE_API_KEY", defaultAPIKey),
		Emulator: os.Getenv("FIREBASE_AUTH_EMULATOR_HOST"),
	}, parts.Email, parts.Password)
	if err != nil {
		return nil, err
	}
	db, err := store.Open(ctx, store.Config{
		ProjectID: env("HIVENOD_PROJECT_ID", defaultProject),
		Emulator:  os.Getenv("FIRESTORE_EMULATOR_HOST"),
		Dial:      os.Getenv("HIVENOD_SPIKE_DIAL"),
	}, sess)
	if err != nil {
		return nil, err
	}
	return &agentConn{sess: sess, db: db, ws: parts.Workspace}, nil
}

func code(err error) string {
	if err == nil {
		return ""
	}
	var ae *auth.Error
	if errors.As(err, &ae) {
		return "auth/" + ae.Code
	}
	if s, ok := status.FromError(err); ok && s.Code() != codes.Unknown {
		return s.Code().String()
	}
	return err.Error()
}

func fail(err error) {
	emit("error", map[string]any{"code": code(err), "message": err.Error()})
	os.Exit(1)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: hivenod-spike whoami|read|apply|listen")
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	c, err := connect(ctx)
	if err != nil {
		fail(err)
	}
	defer c.db.Close()
	switch os.Args[1] {
	case "whoami":
		snap, err := c.db.Doc("workspaces/" + c.ws + "/agents/" + c.sess.UID()).Get(ctx)
		if err != nil {
			fail(err)
		}
		d := snap.Data()
		emit("whoami", map[string]any{"uid": c.sess.UID(), "workspaceId": c.ws, "name": d["name"], "revoked": d["revokedAt"] != nil})
	case "read":
		snap, err := c.db.Doc(os.Args[2]).Get(ctx)
		if err != nil {
			fail(err)
		}
		emit("doc", map[string]any{"path": os.Args[2], "data": jsonable(snap.Data())})
	case "apply":
		raw, _ := io.ReadAll(os.Stdin)
		p, err := plan.Parse(raw)
		if err != nil {
			fail(err)
		}
		if err := plan.Apply(ctx, c.db, p); err != nil {
			fail(err)
		}
		emit("applied", map[string]any{"ops": len(p.Ops)})
	case "listen":
		fs := flag.NewFlagSet("listen", flag.ExitOnError)
		projects := fs.String("projects", "", "comma-separated project ids")
		presence := fs.Duration("presence", 60*time.Second, "presence write interval (0 = off)")
		duration := fs.Duration("duration", 0, "stop after this long (0 = until signalled)")
		_ = fs.Parse(os.Args[2:])
		if *duration > 0 {
			var cancel context.CancelFunc
			ctx, cancel = context.WithTimeout(ctx, *duration)
			defer cancel()
		}
		listen(ctx, c, strings.Split(*projects, ","), *presence)
	default:
		fmt.Fprintln(os.Stderr, "unknown command")
		os.Exit(2)
	}
}

// jsonable turns Firestore values into JSON-friendly ones (times as ISO strings).
func jsonable(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, e := range x {
			out[k] = jsonable(e)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = jsonable(e)
		}
		return out
	case time.Time:
		return x.UTC().Format(time.RFC3339Nano)
	}
	return v
}

// ---------- listening ----------

// watch runs one query or document listener for as long as ctx lives. The Go client already
// resumes broken streams (with a resume token) on Unavailable / Unauthenticated / Internal; if
// the iterator still ends with an error, the listener is started again and its first snapshot
// is a full resync (marked "resync"), so a change made meanwhile is never lost.
func watchQuery(ctx context.Context, name string, q firestore.Query, on func(snap *firestore.QuerySnapshot, resync bool)) {
	backoff := time.Second
	for first := true; ctx.Err() == nil; first = false {
		it := q.Snapshots(ctx)
		resync := !first
		var err error
		for {
			var snap *firestore.QuerySnapshot
			snap, err = it.Next()
			if err != nil {
				break
			}
			backoff = time.Second
			on(snap, resync)
			resync = false
		}
		it.Stop()
		if ctx.Err() != nil || errors.Is(err, iterator.Done) {
			return
		}
		emit("listener-error", map[string]any{"listener": name, "code": code(err)})
		if status.Code(err) == codes.PermissionDenied {
			emit("denied", map[string]any{"listener": name})
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func watchDoc(ctx context.Context, name string, ref *firestore.DocumentRef, on func(snap *firestore.DocumentSnapshot, resync bool)) {
	backoff := time.Second
	for first := true; ctx.Err() == nil; first = false {
		it := ref.Snapshots(ctx)
		resync := !first
		var err error
		for {
			var snap *firestore.DocumentSnapshot
			snap, err = it.Next()
			if err != nil {
				break
			}
			backoff = time.Second
			on(snap, resync)
			resync = false
		}
		it.Stop()
		if ctx.Err() != nil || errors.Is(err, iterator.Done) {
			return
		}
		emit("listener-error", map[string]any{"listener": name, "code": code(err)})
		if status.Code(err) == codes.PermissionDenied {
			emit("denied", map[string]any{"listener": name})
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

type held struct {
	cancel context.CancelFunc
	runID  string
}

func listen(ctx context.Context, c *agentConn, projects []string, presence time.Duration) {
	me := c.sess.UID()
	agentRef := c.db.Doc("workspaces/" + c.ws + "/agents/" + me)
	var wg sync.WaitGroup
	var mu sync.Mutex
	holding := map[string]*held{} // itemPath -> listeners of a held item

	emit("ready", map[string]any{"uid": me, "projects": projects, "tokenExpires": c.sess.Expires().UnixMilli()})

	// The agent doc: revocation, pause, settings.
	wg.Add(1)
	go func() {
		defer wg.Done()
		watchDoc(ctx, "agent", agentRef, func(s *firestore.DocumentSnapshot, resync bool) {
			d := s.Data()
			g, _ := d["guardrails"].(map[string]any)
			emit("agent", map[string]any{"exists": s.Exists(), "name": d["name"], "revoked": d["revokedAt"] != nil, "paused": d["pausedAt"] != nil, "maxFailedRuns": g["maxFailedRuns"], "resync": resync})
		})
	}()

	startHeld := func(path, pid, iid, runID string) {
		hctx, cancel := context.WithCancel(ctx)
		holding[path] = &held{cancel: cancel, runID: runID}
		wg.Add(3)
		go func() {
			defer wg.Done()
			watchDoc(hctx, "item:"+iid, c.db.Doc(path), func(s *firestore.DocumentSnapshot, resync bool) {
				d := s.Data()
				emit("item", map[string]any{"item": iid, "exists": s.Exists(), "title": d["title"], "stepId": d["stepId"], "status": d["status"], "resync": resync})
			})
		}()
		go func() {
			defer wg.Done()
			seen := map[string]bool{}
			watchQuery(hctx, "messages:"+iid, c.db.Collection(path+"/messages").Query, func(s *firestore.QuerySnapshot, resync bool) {
				// Report each message once, whether it came as a change or in a resync.
				ids := []string{}
				for _, d := range s.Changes {
					if d.Kind == firestore.DocumentAdded {
						ids = append(ids, d.Doc.Ref.ID)
					}
				}
				sort.Strings(ids)
				for _, d := range s.Changes {
					if d.Kind != firestore.DocumentAdded || seen[d.Doc.Ref.ID] {
						continue
					}
					seen[d.Doc.Ref.ID] = true
					m := d.Doc.Data()
					emit("message", map[string]any{"item": iid, "id": d.Doc.Ref.ID, "text": m["text"], "kindOf": m["kind"], "resync": resync})
				}
			})
		}()
		go func() {
			defer wg.Done()
			if runID == "" {
				return
			}
			watchDoc(hctx, "run:"+runID, c.db.Doc("workspaces/"+c.ws+"/runs/"+runID), func(s *firestore.DocumentSnapshot, resync bool) {
				emit("run", map[string]any{"item": iid, "run": runID, "status": s.Data()["status"], "resync": resync})
			})
		}()
		emit("holding", map[string]any{"item": iid, "project": pid, "run": runID})
	}

	// The claimable-work query per project; it also tells us which items this agent holds.
	for _, pid := range projects {
		if pid == "" {
			continue
		}
		pid := pid
		q := c.db.Collection("workspaces/"+c.ws+"/projects/"+pid+"/items").Where("status", "in", []any{"queued", "working"})
		wg.Add(1)
		go func() {
			defer wg.Done()
			watchQuery(ctx, "work:"+pid, q, func(s *firestore.QuerySnapshot, resync bool) {
				for _, ch := range s.Changes {
					d := ch.Doc.Data()
					kind := map[firestore.DocumentChangeKind]string{firestore.DocumentAdded: "added", firestore.DocumentModified: "modified", firestore.DocumentRemoved: "removed"}[ch.Kind]
					emit("work", map[string]any{"project": pid, "item": ch.Doc.Ref.ID, "change": kind, "title": d["title"], "status": d["status"], "resync": resync})
				}
				mu.Lock()
				defer mu.Unlock()
				docs, _ := s.Documents.GetAll()
				mine := map[string]bool{}
				for _, d := range docs {
					claim, _ := d.Data()["claim"].(map[string]any)
					path := "workspaces/" + c.ws + "/projects/" + pid + "/items/" + d.Ref.ID
					if claim != nil && claim["agentUid"] == me {
						mine[path] = true
						if _, ok := holding[path]; !ok {
							run, _ := claim["runId"].(string)
							startHeld(path, pid, d.Ref.ID, run)
						}
					}
				}
			})
		}()
	}

	// Presence: a rules-checked write every interval, which also proves writes keep working
	// across ID-token refreshes.
	if presence > 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			host, _ := os.Hostname()
			t := time.NewTicker(presence)
			defer t.Stop()
			for {
				refreshes := c.sess.Refreshes
				wctx, cancel := context.WithTimeout(ctx, 30*time.Second)
				_, err := agentRef.Update(wctx, []firestore.Update{{Path: "lastSeenAt", Value: firestore.ServerTimestamp}, {Path: "seenHost", Value: host}})
				cancel()
				emit("presence", map[string]any{"ok": err == nil, "code": code(err), "refreshes": c.sess.Refreshes, "refreshed": c.sess.Refreshes != refreshes, "tokenExpires": c.sess.Expires().UnixMilli()})
				select {
				case <-ctx.Done():
					return
				case <-t.C:
				}
			}
		}()
	}

	<-ctx.Done()
	mu.Lock()
	for _, h := range holding {
		h.cancel()
	}
	mu.Unlock()
	wg.Wait()
	emit("stopped", map[string]any{"refreshes": c.sess.Refreshes})
}
