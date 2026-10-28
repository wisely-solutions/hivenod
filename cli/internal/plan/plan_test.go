package plan

import (
	"reflect"
	"testing"
)

func TestFoldPrefixes(t *testing.T) {
	in := map[string]any{"pathSkips": map[string]any{}, "pathSkips.draft": "x", "updatedAt": map[string]any{"__hive": "serverTime"}}
	got := FoldPrefixes(in)
	want := map[string]any{"pathSkips": map[string]any{"draft": "x"}, "updatedAt": map[string]any{"__hive": "serverTime"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if _, ok := in["pathSkips.draft"]; !ok {
		t.Fatal("input changed")
	}
	plain := map[string]any{"gate.approvals.alice": 1, "status": "x"}
	if !reflect.DeepEqual(FoldPrefixes(plain), plain) {
		t.Fatal("no prefix: unchanged")
	}
	deep := map[string]any{"a": map[string]any{"k": 1}, "a.b.c": 2}
	if got := FoldPrefixes(deep); !reflect.DeepEqual(got, map[string]any{"a": map[string]any{"k": 1, "b": map[string]any{"c": 2}}}) {
		t.Fatalf("deep: %v", got)
	}
	// A placeholder is not a map to fold into.
	ph := map[string]any{"a": map[string]any{"__hive": "deleteField"}, "a.b": 1}
	if !reflect.DeepEqual(FoldPrefixes(ph), ph) {
		t.Fatal("placeholder folded")
	}
}

func TestParseNumbers(t *testing.T) {
	p, err := Parse([]byte(`{"ops":[{"kind":"set","path":"a/b","data":{"i":3,"f":0.5,"n":{"x":[1,2.5]}}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	d := p.Ops[0].Data
	if d["i"] != int64(3) || d["f"] != 0.5 || d["n"].(map[string]any)["x"].([]any)[0] != int64(1) {
		t.Fatalf("%#v", d)
	}
}
