// Package plan commits action plans (packages/shared/src/actions.ts: one batch = domain change +
// one event doc) with the Go Firestore client. Placeholders are the JSON forms the shared actions
// use: {"__hive":"serverTime"}, {"__hive":"deleteField"}, {"__hive":"arrayUnion","values":[…]},
// {"__hive":"increment","by":n}; plus {"__hive":"timestamp","ms":n} for a Timestamp value.
package plan

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
)

// Op is one write of a plan.
type Op struct {
	Kind string         `json:"kind"`
	Path string         `json:"path"`
	Data map[string]any `json:"data,omitempty"`
}

// Plan is what the shared actions build.
type Plan struct {
	EventID string `json:"eventId,omitempty"`
	Ops     []Op   `json:"ops"`
}

// Parse decodes a plan from JSON, keeping integers as int64 (as the JS SDK writes safe integers).
func Parse(data []byte) (Plan, error) {
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	var p Plan
	if err := d.Decode(&p); err != nil {
		return Plan{}, err
	}
	for i := range p.Ops {
		p.Ops[i].Data, _ = numbers(p.Ops[i].Data).(map[string]any)
	}
	return p, nil
}

func numbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		if !strings.ContainsAny(x.String(), ".eE") {
			if n, err := x.Int64(); err == nil {
				return n
			}
		}
		f, _ := x.Float64()
		return f
	case map[string]any:
		for k, e := range x {
			x[k] = numbers(e)
		}
		return x
	case []any:
		for i, e := range x {
			x[i] = numbers(e)
		}
		return x
	}
	return v
}

// Value turns placeholders into Firestore sentinels, recursively.
func Value(v any) (any, error) {
	switch x := v.(type) {
	case map[string]any:
		if tag, ok := x["__hive"].(string); ok {
			switch tag {
			case "serverTime":
				return firestore.ServerTimestamp, nil
			case "deleteField":
				return firestore.Delete, nil
			case "arrayUnion":
				vals, _ := x["values"].([]any)
				return firestore.ArrayUnion(vals...), nil
			case "increment":
				return firestore.Increment(x["by"]), nil
			case "timestamp":
				ms, ok := x["ms"].(int64)
				if !ok {
					if f, okf := x["ms"].(float64); okf {
						ms, ok = int64(f), true
					}
				}
				if !ok {
					return nil, fmt.Errorf("plan: bad timestamp")
				}
				return time.UnixMilli(ms).UTC(), nil
			}
			return nil, fmt.Errorf("plan: unknown placeholder %q", tag)
		}
		out := make(map[string]any, len(x))
		for k, e := range x {
			c, err := Value(e)
			if err != nil {
				return nil, err
			}
			out[k] = c
		}
		return out, nil
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			c, err := Value(e)
			if err != nil {
				return nil, err
			}
			out[i] = c
		}
		return out, nil
	}
	return v, nil
}

// Apply commits all ops in one atomic batch.
func Apply(ctx context.Context, c *firestore.Client, p Plan) error {
	b := c.Batch() //nolint:staticcheck // BulkWriter is not atomic; a plan must be.
	for _, op := range p.Ops {
		ref := c.Doc(op.Path)
		if ref == nil {
			return fmt.Errorf("plan: bad path %q", op.Path)
		}
		switch op.Kind {
		case "set":
			data, err := Value(op.Data)
			if err != nil {
				return err
			}
			if data == nil {
				data = map[string]any{}
			}
			b.Set(ref, data)
		case "update":
			data := FoldPrefixes(op.Data)
			ups := make([]firestore.Update, 0, len(data))
			for k, e := range data {
				c, err := Value(e)
				if err != nil {
					return err
				}
				ups = append(ups, firestore.Update{Path: k, Value: c})
			}
			b.Update(ref, ups)
		case "delete":
			b.Delete(ref)
		default:
			return fmt.Errorf("plan: unknown op kind %q", op.Kind)
		}
	}
	_, err := b.Commit(ctx)
	return err
}

// FoldPrefixes nests dotted keys into a plain map value given for one of their prefixes in the
// same update, e.g. {"pathSkips": {}, "pathSkips.draft": "x"} -> {"pathSkips": {"draft": "x"}}.
// The JS SDK sends such an update as is and the server ends with the merged map; the Go client
// refuses overlapping paths, so the plan is folded into the same result first.
func FoldPrefixes(data map[string]any) map[string]any {
	keys := make([]string, 0, len(data))
	for k := range data {
		keys = append(keys, k)
	}
	isMap := func(v any) (map[string]any, bool) {
		m, ok := v.(map[string]any)
		if !ok {
			return nil, false
		}
		if _, tag := m["__hive"]; tag {
			return nil, false
		}
		return m, true
	}
	hit := false
	for _, k := range keys {
		for p := k; strings.Contains(p, "."); {
			p = p[:strings.LastIndex(p, ".")]
			if _, ok := isMap(data[p]); ok {
				hit = true
			}
		}
	}
	if !hit {
		return data
	}
	out := make(map[string]any, len(data))
	for k, v := range data {
		out[k] = v
	}
	// Deepest keys first, so a key folds into the nearest prefix that is still present.
	sort.Slice(keys, func(i, j int) bool { return strings.Count(keys[i], ".") > strings.Count(keys[j], ".") })
	for _, k := range keys {
		for p := k; strings.Contains(p, "."); {
			p = p[:strings.LastIndex(p, ".")]
			parent, ok := isMap(out[p])
			if !ok {
				continue
			}
			cp := make(map[string]any, len(parent)+1)
			for pk, pv := range parent {
				cp[pk] = pv
			}
			setPath(cp, strings.Split(k[len(p)+1:], "."), out[k])
			out[p] = cp
			delete(out, k)
			break
		}
	}
	return out
}

func setPath(m map[string]any, segs []string, v any) {
	for len(segs) > 1 {
		next, ok := m[segs[0]].(map[string]any)
		if !ok {
			next = map[string]any{}
		} else {
			cp := make(map[string]any, len(next)+1)
			for k, e := range next {
				cp[k] = e
			}
			next = cp
		}
		m[segs[0]] = next
		m = next
		segs = segs[1:]
	}
	m[segs[0]] = v
}
