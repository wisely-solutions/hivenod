package actions

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRandomID(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		id := RandomID(20)
		if len(id) != 20 || strings.Trim(id, alphabet) != "" {
			t.Fatalf("bad id %q", id)
		}
		seen[id] = true
	}
	if len(seen) != 200 {
		t.Fatal("ids repeat")
	}
	if got := (Ctx{}).nid(); len(got) != 20 {
		t.Fatalf("default NewID gave %q", got)
	}
}

func TestJSStrings(t *testing.T) {
	if got := jsLen("é😀"); got != 3 {
		t.Errorf("jsLen = %d", got)
	}
	if got := jsSlice("ab😀c", 3); got != "ab" {
		t.Errorf("a cut through a pair drops it: %q", got)
	}
	if got := jsSlice("ab😀c", 4); got != "ab😀" {
		t.Errorf("jsSlice = %q", got)
	}
	// JS trims U+FEFF but not U+0085 (Go's TrimSpace does the opposite).
	if got := jsTrim("\ufeff\u2028 x \u0085"); got != "x \u0085" {
		t.Errorf("jsTrim = %q", got)
	}
	if got := jsKeys([]string{"x", "10", "2", "01", "4294967295", "4294967294"}); !reflect.DeepEqual(got,
		[]string{"2", "10", "4294967294", "x", "01", "4294967295"}) {
		t.Errorf("jsKeys = %v", got)
	}
	for _, c := range []struct{ in, want float64 }{{2.5, 3}, {-2.5, -2}, {0.49999999999999994, 0}, {-0.6, -1}} {
		if got := jsRound(c.in); got != c.want {
			t.Errorf("jsRound(%v) = %v", c.in, got)
		}
	}
}

func TestNum(t *testing.T) {
	if _, ok := Num(3).(int64); !ok {
		t.Error("3 should be an int64")
	}
	if _, ok := Num(0.25).(float64); !ok {
		t.Error("0.25 should be a float64")
	}
	if _, ok := Num(1 << 54).(float64); !ok {
		t.Error("an unsafe integer stays a float64")
	}
}

func TestMaybe(t *testing.T) {
	var in struct {
		Model Maybe[string] `json:"model"`
	}
	if err := json.Unmarshal([]byte(`{}`), &in); err != nil || in.Model.Set {
		t.Fatalf("absent: %+v %v", in.Model, err)
	}
	if err := json.Unmarshal([]byte(`{"model":null}`), &in); err != nil || !in.Model.Set || in.Model.V != nil {
		t.Fatalf("null: %+v %v", in.Model, err)
	}
	if err := json.Unmarshal([]byte(`{"model":"m"}`), &in); err != nil || !in.Model.Set || *in.Model.V != "m" {
		t.Fatalf("given: %+v %v", in.Model, err)
	}
	if g := Given("m"); !g.Set || *g.V != "m" {
		t.Errorf("Given: %+v", g)
	}
}
