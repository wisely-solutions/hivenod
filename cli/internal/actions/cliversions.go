package actions

// The minimum CLI version per event kind (item N9EEnCa1MzIw5UYfe70N): the table of
// packages/shared/src/cliversion.ts, embedded as cliversions.json and kept equal by
// scripts/cli-versions.test.mjs. A CLI older than a kind's row ignores that event.

import (
	_ "embed"
	"encoding/json"
	"strconv"
	"strings"
)

//go:embed cliversions.json
var cliVersionsJSON []byte

var eventMinVersion = func() map[string]string {
	m := map[string]string{}
	if err := json.Unmarshal(cliVersionsJSON, &m); err != nil {
		panic("cliversions.json: " + err.Error())
	}
	return m
}()

// EventMinVersion is the oldest CLI version that handles an event kind ("" when every CLI does).
func EventMinVersion(kind string) string { return eventMinVersion[kind] }

// EventKinds is every kind that has a minimum version.
func EventKinds() []string {
	out := make([]string, 0, len(eventMinVersion))
	for k := range eventMinVersion {
		out = append(out, k)
	}
	return out
}

// CompareVersions compares dotted numbers part by part (same as compareVersions in TypeScript):
// negative when a < b, 0 when equal, positive when a > b.
func CompareVersions(a, b string) int {
	pa, pb := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(pa) || i < len(pb); i++ {
		var x, y int
		if i < len(pa) {
			x, _ = strconv.Atoi(pa[i])
		}
		if i < len(pb) {
			y, _ = strconv.Atoi(pb[i])
		}
		if x != y {
			return x - y
		}
	}
	return 0
}

// SupportsEvent: a CLI of this version handles the kind.
func SupportsEvent(kind, version string) bool {
	min := EventMinVersion(kind)
	return min == "" || CompareVersions(version, min) >= 0
}
