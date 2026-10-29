package hive

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
)

func TestWatchBusyStartsWhenOtherSessionStops(t *testing.T) {
	s := NewSession(nil, Config{}, func(Event) {}, ChannelOptions{})
	var calls atomic.Int32
	check := func(context.Context) (string, *actions.Terminal, bool) {
		if calls.Add(1) < 3 {
			return actions.PresenceBusy, nil, true
		}
		return actions.PresenceFree, nil, true
	}
	freed := make(chan struct{})
	go s.watchBusy(context.Background(), check, 5*time.Millisecond, func(string, *actions.Terminal) { close(freed) })
	select {
	case <-freed:
	case <-time.After(2 * time.Second):
		t.Fatal("never started after the other session stopped")
	}
	if calls.Load() != 3 {
		t.Fatalf("checks = %d, want 3", calls.Load())
	}
}

func TestWatchBusyStaysBusyWhileOtherLive(t *testing.T) {
	s := NewSession(nil, Config{}, func(Event) {}, ChannelOptions{})
	var fired atomic.Bool
	var calls atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		s.watchBusy(ctx, func(context.Context) (string, *actions.Terminal, bool) {
			calls.Add(1)
			return actions.PresenceBusy, nil, true
		}, 5*time.Millisecond, func(string, *actions.Terminal) { fired.Store(true) })
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("did not stop with the context")
	}
	if fired.Load() || calls.Load() < 3 {
		t.Fatalf("fired=%v calls=%d", fired.Load(), calls.Load())
	}
}
