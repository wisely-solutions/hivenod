package hive

import "testing"

func TestClipLikeTypeScript(t *testing.T) {
	if clip("abc", 5) != "abc" || clip("abcdef", 4) != "abc…" {
		t.Fatal(clip("abcdef", 4))
	}
}
