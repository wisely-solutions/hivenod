package hive

import (
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckCreateRate(t *testing.T) {
	now := int64(10_000_000)
	var times []int64
	for i := 0; i < 29; i++ {
		times = append(times, now-int64(i)*60_000)
	}
	if _, err := CheckCreateRate(times, now, 30, time.Hour); err != nil {
		t.Fatalf("29 in the hour must pass: %v", err)
	}
	// The 30th was 50 minutes ago: the 31st waits 10 minutes.
	times = append(times, now-50*60_000)
	_, err := CheckCreateRate(times, now, 30, time.Hour)
	if err == nil || !strings.Contains(err.Error(), "at most 30 per hour") || !strings.Contains(err.Error(), "in 10 minutes") {
		t.Fatalf("want the limit message, got %v", err)
	}
	// Creations older than the window no longer count.
	old := []int64{}
	for i := 0; i < 40; i++ {
		old = append(old, now-time.Hour.Milliseconds()-int64(i))
	}
	kept, err := CheckCreateRate(old, now, 30, time.Hour)
	if err != nil || len(kept) != 0 {
		t.Fatalf("old creations must drop: %v %d", err, len(kept))
	}
}

func TestCreateRateMessageRoundsUp(t *testing.T) {
	if m := CreateRateMessage(30, 30*time.Second); !strings.Contains(m, "in 1 minute.") {
		t.Fatal(m)
	}
}

func TestCreateLimiterSharedThroughTheFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "created-items.json")
	at := time.UnixMilli(50_000_000)
	clock := func() time.Time { return at }
	a := &CreateLimiter{Path: path, Now: clock, Limit: 3}
	for i := 0; i < 3; i++ {
		if err := a.Check("ag1"); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
		a.Record("ag1")
		at = at.Add(time.Minute)
	}
	if err := a.Check("ag1"); err == nil {
		t.Fatal("the 4th must be refused")
	}
	// Another process (a new limiter on the same file) sees the same count; other agents do not.
	b := &CreateLimiter{Path: path, Now: clock, Limit: 3}
	if err := b.Check("ag1"); err == nil {
		t.Fatal("the count must be shared through the file")
	}
	if err := b.Check("ag2"); err != nil {
		t.Fatalf("another agent has its own count: %v", err)
	}
	// An hour after the first, a slot frees.
	at = time.UnixMilli(50_000_000).Add(time.Hour + time.Second)
	if err := b.Check("ag1"); err != nil {
		t.Fatalf("a slot must free after the window: %v", err)
	}
	// Without a file it still counts in memory.
	m := &CreateLimiter{Now: clock, Limit: 1}
	m.Record("ag1")
	if err := m.Check("ag1"); err == nil {
		t.Fatal("in-memory count must hold")
	}
}
