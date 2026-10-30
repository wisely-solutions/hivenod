package actions

import (
	"strings"
	"testing"
)

// The 900 KB limit (kept out of the contract fixture, which would grow by a megabyte).
func TestThreadAttachTooBig(t *testing.T) {
	big := strings.Repeat("x", 900*1024+1)
	ctx := Ctx{WorkspaceID: "w1", Actor: Actor{Type: "agent", ID: "agentA", Name: "Hive"}}
	_, err := ThreadAttach(ctx, ThreadAttachInput{
		ThreadID: "it1", Thread: ThreadState{MemberUID: "joao", FetchedBy: "agentA"},
		Kind: "text", Name: "big.txt", Content: &big,
	})
	if err == nil || err.Error() != "Attachments over 900 KB must be attached as a link" {
		t.Fatalf("got %v", err)
	}
	ok := strings.Repeat("x", 900*1024)
	if _, err := ThreadAttach(ctx, ThreadAttachInput{
		ThreadID: "it1", Thread: ThreadState{MemberUID: "joao", FetchedBy: "agentA"},
		Kind: "text", Name: "ok.txt", Content: &ok,
	}); err != nil {
		t.Fatal(err)
	}
}
