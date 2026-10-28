package hive

import (
	"errors"
	"strings"
	"testing"
)

func TestSayConnect(t *testing.T) {
	var out []string
	say := func(s string) { out = append(out, s) }
	var opened string
	sayConnect(say, "https://hivenod.com/", "K7QX29PD", "laptop", 10, func(u string) error { opened = u; return nil })
	text := strings.Join(out, "\n")
	if opened != "https://hivenod.com/connect?code=K7QX-29PD" {
		t.Fatalf("opened %q", opened)
	}
	for _, want := range []string{"Opened your browser", "(laptop)", "https://hivenod.com/connect?code=K7QX-29PD", "enter the code K7QX-29PD", "10 minutes"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in\n%s", want, text)
		}
	}
	out = nil
	sayConnect(say, "https://hivenod.com", "K7QX29PD", "", 10, func(string) error { return errors.New("no display") })
	text = strings.Join(out, "\n")
	if strings.Contains(text, "Opened") || !strings.Contains(text, "Open this link") || !strings.Contains(text, "go to https://hivenod.com/connect and enter") {
		t.Fatalf("no browser:\n%s", text)
	}
}
