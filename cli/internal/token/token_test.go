package token

import (
	"encoding/base64"
	"strings"
	"testing"
)

func enc(json string) string { return Prefix + base64.RawURLEncoding.EncodeToString([]byte(json)) }

func TestDecode(t *testing.T) {
	good := enc(`{"p":"0123456789abcdefXYZ","w":"w1","e":"agent-abcdefghijkl@agents.hive-board.app"}`)
	p, err := Decode("  " + good + "\n")
	if err != nil {
		t.Fatal(err)
	}
	if p.Workspace != "w1" || p.Email != "agent-abcdefghijkl@agents.hive-board.app" || p.Password != "0123456789abcdefXYZ" {
		t.Fatalf("got %+v", p)
	}
}

func TestDecodeRejects(t *testing.T) {
	for _, bad := range []string{
		"",
		"hive_agt_",
		"nope_" + strings.Repeat("a", 30),
		"hive_agt_???",
		enc(`{"p":"short","w":"w1","e":"agent-abcdefghijkl@agents.hive-board.app"}`),
		enc(`{"p":"0123456789abcdefXYZ","w":"","e":"agent-abcdefghijkl@agents.hive-board.app"}`),
		enc(`{"p":"0123456789abcdefXYZ","w":"w1","e":"someone@example.com"}`),
		enc(`{"p":"0123456789abcdefXYZ","w":"w1"}`),
		enc(`not json`),
	} {
		if _, err := Decode(bad); err != ErrInvalid {
			t.Errorf("Decode(%q) = %v, want ErrInvalid", bad, err)
		}
	}
}
