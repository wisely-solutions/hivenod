package hive

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

// Claim race (item lkkyB), against the Firestore emulator with the real rules (run it with
// `node scripts/emu-exec.mjs "cd cli && go test -race ./internal/hive -run ClaimRace"`; it skips
// without FIRESTORE_EMULATOR_HOST). Agents act with their own identity (the emulator accepts an
// unsigned token), so the rules judge each commit against the document as it is at that moment.

const raceWS = "w1"

// raceProject is the emulator's project (emulators:exec sets GCLOUD_PROJECT).
func raceProject() string {
	for _, k := range []string{"GCLOUD_PROJECT", "GOOGLE_CLOUD_PROJECT"} {
		if v := os.Getenv(k); v != "" {
			return v
		}
	}
	return "demo-race"
}

type bearer string

func (b bearer) GetRequestMetadata(context.Context, ...string) (map[string]string, error) {
	return map[string]string{"authorization": "Bearer " + string(b)}, nil
}
func (bearer) RequireTransportSecurity() bool { return false }

// asAgent: a Firestore client signed in as uid (unsigned emulator token).
func asAgent(t *testing.T, ctx context.Context, host, uid string) *firestore.Client {
	t.Helper()
	enc := base64.RawURLEncoding.EncodeToString
	tok := enc([]byte(`{"alg":"none","typ":"JWT"}`)) + "." +
		enc([]byte(fmt.Sprintf(`{"user_id":%q,"sub":%q,"aud":%q,"iss":"https://securetoken.google.com/%s","firebase":{"sign_in_provider":"custom"}}`, uid, uid, raceProject(), raceProject()))) + "."
	// With FIRESTORE_EMULATOR_HOST set, the SDK signs in as the emulator owner (rules bypassed) and
	// ignores our options: build this client without it.
	_ = os.Unsetenv("FIRESTORE_EMULATOR_HOST")
	defer os.Setenv("FIRESTORE_EMULATOR_HOST", host)
	c, err := firestore.NewClient(ctx, raceProject(),
		option.WithEndpoint(host), option.WithoutAuthentication(),
		option.WithGRPCDialOption(grpc.WithTransportCredentials(insecure.NewCredentials())),
		option.WithGRPCDialOption(grpc.WithPerRPCCredentials(bearer(tok))))
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func raceSeed(t *testing.T, ctx context.Context, admin *firestore.Client, agents, items int) {
	t.Helper()
	now := time.Now()
	set := func(path string, data map[string]any) {
		if _, err := admin.Doc(path).Set(ctx, data); err != nil {
			t.Fatal(err)
		}
	}
	set(model.Paths.Workspace(raceWS), map[string]any{"name": "Hive", "ownerUid": "owner", "adminUids": []string{"owner"},
		"memberRoles": map[string]any{"owner": "admin"}, "createdAt": now, "lastEventId": "seed"})
	steps := []map[string]any{{"id": "draft", "name": "Draft", "kind": "agent", "description": "Write it", "instructions": "Write"}}
	set(model.Paths.Project(raceWS, "p1"), map[string]any{"name": "Blog", "emoji": "x", "color": "#2F5FD0", "templateId": "content",
		"steps": steps, "stepIndex": map[string]any{"draft": 0}, "memberUids": []string{"owner"}, "createdBy": "owner",
		"createdAt": now, "archivedAt": nil, "lastEventId": "seed"})
	for a := 0; a < agents; a++ {
		set(model.Paths.Agent(raceWS, fmt.Sprintf("agent%d", a)), map[string]any{"name": "Agent", "color": "#2F5FD0", "projectIds": []string{"p1"},
			"createdBy": "owner", "createdAt": now, "revokedAt": nil, "lastSeenAt": nil, "tokenHint": "a7f3", "previousAgentUid": nil, "lastEventId": "seed"})
	}
	for i := 0; i < items; i++ {
		set(model.Paths.Item(raceWS, "p1", fmt.Sprintf("i%d", i)), map[string]any{"title": "Post", "type": "idea", "stepId": "draft", "status": "queued",
			"summary": "", "source": map[string]any{"kind": "manual", "label": "x"}, "createdBy": map[string]any{"type": "human", "id": "owner"},
			"parentItemId": nil, "sourceRunId": nil, "claim": nil, "progress": nil, "gate": nil, "triage": nil, "sendBackCount": 0,
			"costEur": 0, "order": float64(i), "updatedAt": now, "lastEventId": "seed"})
	}
}

// tryClaim: the claim write of agent uid on item id, as Client.Claim writes it (one atomic batch).
func tryClaim(ctx context.Context, db *firestore.Client, uid, id string) error {
	p, err := actions.ClaimItem(actions.Ctx{WorkspaceID: raceWS, Actor: actions.Actor{Type: "agent", ID: uid, Name: uid}},
		actions.ClaimItemInput{ProjectID: "p1", ItemID: id, Item: model.Item{StepID: "draft", Status: "queued"}})
	if err != nil {
		return err
	}
	return plan.Apply(ctx, db, p.Plan)
}

func raceSetup(t *testing.T, agents, items int) (context.Context, []*firestore.Client, *firestore.Client) {
	host := os.Getenv("FIRESTORE_EMULATOR_HOST")
	if host == "" {
		t.Skip("needs the Firestore emulator (FIRESTORE_EMULATOR_HOST)")
	}
	ctx := context.Background()
	admin, err := firestore.NewClient(ctx, raceProject())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	raceSeed(t, ctx, admin, agents, items)
	var dbs []*firestore.Client
	for a := 0; a < agents; a++ {
		db := asAgent(t, ctx, host, fmt.Sprintf("agent%d", a))
		t.Cleanup(func() { _ = db.Close() })
		dbs = append(dbs, db)
	}
	return ctx, dbs, admin
}

// N agents claim the same item at the same moment: exactly one wins, the others are denied.
func TestClaimRaceOneItem(t *testing.T) {
	const n = 8
	ctx, dbs, admin := raceSetup(t, n, 1)
	var wg sync.WaitGroup
	start := make(chan struct{})
	errs := make([]error, n)
	for a := 0; a < n; a++ {
		wg.Add(1)
		go func(a int) {
			defer wg.Done()
			<-start
			errs[a] = tryClaim(ctx, dbs[a], fmt.Sprintf("agent%d", a), "i0")
		}(a)
	}
	close(start)
	wg.Wait()
	wins := 0
	for _, err := range errs {
		if err == nil {
			wins++
		} else if !Denied(err) && status.Code(err) != codes.Aborted {
			// Aborted: the emulator gave up on lock contention between simultaneous commits.
			t.Fatalf("a loser must be denied cleanly, got %v", err)
		}
	}
	if wins != 1 {
		t.Fatalf("%d agents won the claim, want exactly 1", wins)
	}
	snap, err := admin.Doc(model.Paths.Item(raceWS, "p1", "i0")).Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var it model.Item
	_ = snap.DataTo(&it)
	if it.Claim == nil || it.Status != "working" {
		t.Fatalf("item not held: %+v", it)
	}
}

// M items and N agents, each agent claiming every item in its own order: every item ends with
// exactly one holder, none lost, and a lost claim is a denial the client reports as "taken".
func TestClaimRaceManyItems(t *testing.T) {
	const n, m = 4, 12
	ctx, dbs, admin := raceSetup(t, n, m)
	var wg sync.WaitGroup
	var mu sync.Mutex
	won := map[string][]string{}
	for a := 0; a < n; a++ {
		wg.Add(1)
		go func(a int) {
			defer wg.Done()
			uid := fmt.Sprintf("agent%d", a)
			for k := 0; k < m; k++ {
				id := fmt.Sprintf("i%d", (k+a*3)%m)
				err := tryClaim(ctx, dbs[a], uid, id)
				if err == nil {
					mu.Lock()
					won[id] = append(won[id], uid)
					mu.Unlock()
				} else if !Denied(err) {
					t.Errorf("%s on %s: %v", uid, id, err)
				}
			}
		}(a)
	}
	wg.Wait()
	for i := 0; i < m; i++ {
		id := fmt.Sprintf("i%d", i)
		if len(won[id]) != 1 {
			t.Fatalf("item %s won by %v, want exactly one", id, won[id])
		}
		snap, err := admin.Doc(model.Paths.Item(raceWS, "p1", id)).Get(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var it model.Item
		_ = snap.DataTo(&it)
		if it.Claim == nil || it.Claim.AgentUID != won[id][0] {
			t.Fatalf("item %s held by %+v, winner %v", id, it.Claim, won[id])
		}
	}
	// A denied claim reads as "taken": diagnose is covered by IsTaken's message.
	if !IsTaken(Errf(TakenPrefix + ".")) {
		t.Fatal("taken message")
	}
}

// Control: the rules are enforced for these clients (an identity with no agent document is denied).
func TestClaimRaceControl(t *testing.T) {
	ctx, _, _ := raceSetup(t, 1, 1)
	stranger := asAgent(t, ctx, os.Getenv("FIRESTORE_EMULATOR_HOST"), "nobody")
	defer stranger.Close()
	if err := tryClaim(ctx, stranger, "nobody", "i0"); !Denied(err) {
		t.Fatalf("an unknown agent must be denied, got %v", err)
	}
}
