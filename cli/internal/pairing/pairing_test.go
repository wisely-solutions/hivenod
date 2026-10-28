package pairing

import (
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func TestOpenTypeScriptVector(t *testing.T) {
	raw, err := os.ReadFile("testdata/vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		PrivateD, PublicKey, Code, Token string
		Sealed                           Sealed
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	d, _ := base64.RawURLEncoding.DecodeString(v.PrivateD)
	k, err := KeysFromD(d)
	if err != nil {
		t.Fatal(err)
	}
	if k.PublicKey != v.PublicKey {
		t.Fatal("public key differs from the TypeScript export")
	}
	got, err := k.Open(v.Sealed, v.Code)
	if err != nil || got != v.Token {
		t.Fatalf("open: %q %v", got, err)
	}
	if _, err := k.Open(v.Sealed, "AAAAAAAA"); err != ErrOpen {
		t.Fatal("a different code must not open it")
	}
	other, _ := NewKeys()
	if _, err := other.Open(v.Sealed, v.Code); err != ErrOpen {
		t.Fatal("another key must not open it")
	}
}

func TestCode(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c := NewCode()
		if len(c) != CodeLength {
			t.Fatal(c)
		}
		for _, ch := range c {
			if !strings.ContainsRune(Alphabet, ch) {
				t.Fatal(c)
			}
		}
		seen[c] = true
	}
	if len(seen) < 199 {
		t.Fatal("codes repeat")
	}
	if Format("K7QX29PD") != "K7QX-29PD" {
		t.Fatal("format")
	}
	if URL("https://hivenod.com/", "K7QX29PD") != "https://hivenod.com/agents/connect?code=K7QX-29PD" {
		t.Fatal("url")
	}
	if ConnectURL("https://hivenod.com/", "K7QX29PD") != "https://hivenod.com/connect?code=K7QX-29PD" {
		t.Fatal("connect url")
	}
	if ConnectPage("https://hivenod.com/") != "https://hivenod.com/connect" {
		t.Fatal("connect page")
	}
	if ConnectTTL != 10*time.Minute || TTL != 15*time.Minute {
		t.Fatal("ttl mirrors firestore.rules")
	}
	r := ConnectRequest("pk", "claude", "laptop", "blog")
	if r["kind"] != "connect" || r["status"] != "pending" {
		t.Fatal("connect request")
	}
	if _, ok := Request("pk", "claude", "laptop", "blog")["kind"]; ok {
		t.Fatal("a pair request has no kind")
	}
	k, _ := NewKeys()
	if b, _ := base64.RawURLEncoding.DecodeString(k.PublicKey); len(b) != 65 {
		t.Fatal("public key must be a raw uncompressed point")
	}
}
