package hive

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"cloud.google.com/go/firestore"

	"github.com/wisely-solutions/hivenod/cli/internal/pairing"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
	"github.com/wisely-solutions/hivenod/cli/internal/store"
)

// Paired is what pairing hands back. The token is never printed.
type Paired struct {
	Code        string
	Token       string
	WorkspaceID string
	AgentUID    string
	AgentName   string
}

// PairOptions for PairTerminal.
type PairOptions struct {
	CLI    string
	Say    func(string)
	Folder string
	TTL    time.Duration
}

type pairingDoc struct {
	Status      string          `firestore:"status"`
	WorkspaceID string          `firestore:"workspaceId"`
	AgentUID    string          `firestore:"agentUid"`
	AgentName   string          `firestore:"agentName"`
	Sealed      *pairing.Sealed `firestore:"sealed"`
}

func (c Config) storeConfig() store.Config {
	return store.Config{ProjectID: c.ProjectID, Emulator: c.FSEmulator}
}

// PairTerminal shows a code, waits until an admin confirms it in Hivenod, and receives the new
// agent's token encrypted for a key that never leaves this process (packages/agent/src/pair.ts).
func PairTerminal(ctx context.Context, cfg Config, o PairOptions) (*Paired, error) {
	keys, err := pairing.NewKeys()
	if err != nil {
		return nil, err
	}
	db, err := store.Open(ctx, cfg.storeConfig(), store.Anonymous{})
	if err != nil {
		return nil, err
	}
	defer db.Close()
	host, _ := os.Hostname()
	folder := o.Folder
	if folder == "" {
		wd, _ := os.Getwd()
		folder = filepath.Base(wd)
	}
	req := pairing.Request(keys.PublicKey, o.CLI, host, folder)
	var code string
	for attempt := 0; ; attempt++ {
		code = pairing.NewCode()
		err = plan.Apply(ctx, db, plan.Plan{Ops: []plan.Op{{Kind: "set", Path: pairing.Path(code), Data: req}}})
		if err == nil {
			break
		}
		// Denied means the code is taken (a create cannot overwrite): draw another one.
		if !Denied(err) || attempt >= 4 {
			return nil, err
		}
	}
	ttl := o.TTL
	if ttl == 0 {
		ttl = pairing.TTL
	}
	say := o.Say
	say("This terminal is not connected to Hivenod yet. To connect it, open")
	say("  " + pairing.URL(cfg.WebURL, code))
	say(fmt.Sprintf("and confirm the code %s (Agents, Connect a terminal). It expires in %d minutes.", pairing.Format(code), int(ttl.Round(time.Minute)/time.Minute)))
	say("Waiting for confirmation… (Ctrl+C to cancel)")

	wctx, cancel := context.WithTimeout(ctx, ttl)
	defer cancel()
	doc, werr := waitForPairing(wctx, db.Doc(pairing.Path(code)))
	if doc == nil {
		dctx, dcancel := context.WithTimeout(context.Background(), 10*time.Second)
		_, _ = db.Doc(pairing.Path(code)).Delete(dctx)
		dcancel()
		if werr != nil && !errors.Is(werr, context.DeadlineExceeded) && !errors.Is(werr, context.Canceled) {
			return nil, werr
		}
		if ctx.Err() != nil {
			return nil, Errf("Pairing cancelled.")
		}
		return nil, Errf("The code expired before anyone confirmed it. Run the command again for a new code.")
	}
	tok, err := keys.Open(*doc.Sealed, code)
	if err != nil {
		return nil, Errf("Hivenod answered, but the token could not be decrypted for this terminal. Run the command again for a new code.")
	}
	name := doc.AgentName
	if name == "" {
		name = "agent"
	}
	return &Paired{Code: code, Token: tok, WorkspaceID: doc.WorkspaceID, AgentUID: doc.AgentUID, AgentName: name}, nil
}

func waitForPairing(ctx context.Context, ref *firestore.DocumentRef) (*pairingDoc, error) {
	for ctx.Err() == nil {
		it := ref.Snapshots(ctx)
		for {
			snap, err := it.Next()
			if err != nil {
				it.Stop()
				if ctx.Err() != nil {
					return nil, ctx.Err()
				}
				if Denied(err) {
					return nil, err
				}
				break // a broken stream: listen again
			}
			if !snap.Exists() {
				continue
			}
			var d pairingDoc
			if err := snap.DataTo(&d); err != nil {
				continue
			}
			if d.Status == "paired" && d.Sealed != nil {
				it.Stop()
				return &d, nil
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
	return nil, ctx.Err()
}
