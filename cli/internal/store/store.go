// Package store opens a Firestore client that talks to Firestore as the signed-in agent: every
// call carries the agent's Firebase ID token, so firestore.rules decide (never a service account,
// never admin access). The emulator gets the same treatment (no "owner" bypass).
package store

import (
	"context"
	"crypto/tls"
	"math"
	"net"
	"os"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/option"
	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/keepalive"
)

// Config says which Firestore to use.
type Config struct {
	ProjectID string
	// Emulator is host:port of the Firestore emulator ("" for production).
	Emulator string
	// Dial, when set, is the address actually dialled (a local forwarder in tests); TLS still
	// checks firestore.googleapis.com in production.
	Dial string
}

const prodHost = "firestore.googleapis.com:443"

// Open connects. creds supplies the agent's ID token for each call.
func Open(ctx context.Context, cfg Config, creds credentials.PerRPCCredentials) (*firestore.Client, error) {
	c, _, err := OpenWatched(ctx, cfg, creds)
	return c, err
}

// Reconnects tells listeners when the connection is back after a break (a network drop), so they
// can listen again at once instead of waiting out the client's own retry backoff (up to a minute).
type Reconnects struct {
	mu sync.Mutex
	ch chan struct{}
	n  int
}

// Next is closed at the next reconnect.
func (r *Reconnects) Next() <-chan struct{} {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.ch
}

// Count is how many reconnects there were.
func (r *Reconnects) Count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.n
}

func (r *Reconnects) fire() {
	r.mu.Lock()
	close(r.ch)
	r.ch = make(chan struct{})
	r.n++
	r.mu.Unlock()
}

func watchState(conn *grpc.ClientConn, r *Reconnects) {
	ready := false
	broken := false
	for {
		st := conn.GetState()
		switch st {
		case connectivity.Ready:
			if ready && broken {
				r.fire()
			}
			ready, broken = true, false
		case connectivity.TransientFailure, connectivity.Connecting, connectivity.Idle:
			if ready {
				broken = true
			}
		case connectivity.Shutdown:
			return
		}
		if !conn.WaitForStateChange(context.Background(), st) {
			return
		}
	}
}

// OpenWatched is Open, plus the reconnect signal.
func OpenWatched(ctx context.Context, cfg Config, creds credentials.PerRPCCredentials) (*firestore.Client, *Reconnects, error) {
	// The Go client would otherwise dial the emulator itself with the rules-bypassing "owner" token.
	_ = os.Unsetenv("FIRESTORE_EMULATOR_HOST")
	target := prodHost
	var tc credentials.TransportCredentials = credentials.NewTLS(&tls.Config{ServerName: "firestore.googleapis.com", MinVersion: tls.VersionTLS12})
	if cfg.Emulator != "" {
		target = cfg.Emulator
		tc = insecure.NewCredentials()
	}
	opts := []grpc.DialOption{
		grpc.WithTransportCredentials(tc),
		grpc.WithPerRPCCredentials(creds),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(math.MaxInt32), grpc.MaxCallSendMsgSize(math.MaxInt32)),
		// A dead network (laptop asleep, Wi-Fi switched) can leave the TCP connection silently
		// open; keepalive pings notice within ~45 s so the listeners reconnect and resync.
		grpc.WithKeepaliveParams(keepalive.ClientParameters{Time: 30 * time.Second, Timeout: 15 * time.Second}),
		// Reconnect within seconds of the network coming back (the default backoff grows to 2 min).
		grpc.WithConnectParams(grpc.ConnectParams{Backoff: backoff.Config{BaseDelay: time.Second, Multiplier: 1.6, Jitter: 0.2, MaxDelay: 10 * time.Second}, MinConnectTimeout: 10 * time.Second}),
	}
	if cfg.Emulator == "" {
		opts = append(opts, grpc.WithAuthority("firestore.googleapis.com"))
	}
	if cfg.Dial != "" {
		addr := cfg.Dial
		opts = append(opts, grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", addr)
		}))
	}
	conn, err := grpc.NewClient("dns:///"+target, opts...)
	if err != nil {
		return nil, nil, err
	}
	r := &Reconnects{ch: make(chan struct{})}
	go watchState(conn, r)
	c, err := firestore.NewClient(ctx, cfg.ProjectID, option.WithGRPCConn(conn))
	if err != nil {
		conn.Close()
		return nil, nil, err
	}
	return c, r, nil
}

// Anonymous is for the calls made before sign-in (pairing requests): no token at all.
type Anonymous struct{}

func (Anonymous) GetRequestMetadata(context.Context, ...string) (map[string]string, error) {
	return map[string]string{}, nil
}
func (Anonymous) RequireTransportSecurity() bool { return false }
