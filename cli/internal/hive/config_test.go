package hive

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/discovery"
)

func clearEnv(t *testing.T) {
	for _, k := range []string{"HIVENOD_WEB_URL", "HIVENOD_FIREBASE_API_KEY", "HIVENOD_FIREBASE_PROJECT_ID", "HIVENOD_PROJECT_ID", "FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST"} {
		t.Setenv(k, "")
	}
}

func site(t *testing.T, hits *atomic.Int32) *httptest.Server {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != discovery.Path {
			w.WriteHeader(404)
			return
		}
		hits.Add(1)
		_, _ = w.Write([]byte(`{"service":"hivenod","protocol":1,"firebase":{"apiKey":"self-key","authDomain":"127.0.0.1","projectId":"self-proj"},"emulators":{"auth":"127.0.0.1:9","firestore":"127.0.0.1:8"}}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestResolveHostedNeedsNoNetwork(t *testing.T) {
	clearEnv(t)
	c, err := Resolve(context.Background(), "", nil)
	if err != nil || c.APIKey != defaultAPIKey || c.ProjectID != defaultProject || c.WebURL != "https://hivenod.com" || c.Discovery != nil {
		t.Fatalf("got %+v %v", c, err)
	}
	// An agent.json written before servers existed: the hosted service, unchanged.
	c, err = Resolve(context.Background(), "", &credentials.Stored{Token: "t"})
	if err != nil || c.ProjectID != defaultProject {
		t.Fatalf("got %+v %v", c, err)
	}
	c, err = Resolve(context.Background(), "hivenod.com", nil)
	if err != nil || c.ProjectID != defaultProject {
		t.Fatalf("got %+v %v", c, err)
	}
}

func TestResolveFromDiscovery(t *testing.T) {
	clearEnv(t)
	var hits atomic.Int32
	srv := site(t, &hits)
	c, err := Resolve(context.Background(), srv.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if c.APIKey != "self-key" || c.ProjectID != "self-proj" || c.WebURL != srv.URL || c.AuthEmulator != "127.0.0.1:9" || c.FSEmulator != "127.0.0.1:8" || c.Discovery == nil {
		t.Fatalf("got %+v", c)
	}
	// HIVENOD_WEB_URL does the same as --server.
	t.Setenv("HIVENOD_WEB_URL", srv.URL+"/")
	if c, err := Resolve(context.Background(), "", nil); err != nil || c.ProjectID != "self-proj" {
		t.Fatalf("got %+v %v", c, err)
	}
	t.Setenv("HIVENOD_WEB_URL", "")
	// The copy saved with the token is used without reading the site again.
	saved := &credentials.Stored{Token: "t", Server: c.WebURL, Discovery: c.Discovery}
	before := hits.Load()
	if c2, err := Resolve(context.Background(), "", saved); err != nil || c2.ProjectID != "self-proj" || hits.Load() != before {
		t.Fatalf("got %+v %v (hits %d -> %d)", c2, err, before, hits.Load())
	}
	// A saved server without its copy reads the site.
	if c2, err := Resolve(context.Background(), "", &credentials.Stored{Server: c.WebURL}); err != nil || c2.ProjectID != "self-proj" || hits.Load() != before+1 {
		t.Fatalf("got %+v %v", c2, err)
	}
}

func TestResolveExplicitEnvWins(t *testing.T) {
	clearEnv(t)
	t.Setenv("HIVENOD_FIREBASE_API_KEY", "env-key")
	t.Setenv("HIVENOD_FIREBASE_PROJECT_ID", "env-proj")
	c, err := Resolve(context.Background(), "https://your.host", nil)
	if err != nil || c.APIKey != "env-key" || c.ProjectID != "env-proj" || c.WebURL != "https://your.host" {
		t.Fatalf("got %+v %v", c, err)
	}
}

func TestResolveErrors(t *testing.T) {
	clearEnv(t)
	if _, err := Resolve(context.Background(), "http://your.host", nil); err == nil || !strings.Contains(Message(err), "https") {
		t.Fatalf("got %v", err)
	}
	nf := httptest.NewServer(http.NotFoundHandler())
	defer nf.Close()
	if _, err := Resolve(context.Background(), nf.URL, nil); err == nil || !strings.Contains(Message(err), "does not look like a Hivenod site") {
		t.Fatalf("got %v", err)
	}
}
