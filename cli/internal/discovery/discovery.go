// Package discovery reads a Hivenod site's /.well-known/hivenod.json (item
// 07W4gCboOicS0lM1bqwZ): the public Firebase web config, the CLI download base and the protocol,
// so an agent needs only the site's address. It mirrors packages/shared/src/discovery.ts; both
// are checked against the shared cases in testdata/cases.json.
package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Path is where the file is served, relative to the site.
const Path = "/.well-known/hivenod.json"

// Protocol is the newest discovery format this CLI understands.
const Protocol = 1

// HostedSite is the hosted service; installs without a server use it, as before.
const HostedSite = "https://hivenod.com"

// Firebase is a Firebase web app config (public by design).
type Firebase struct {
	APIKey            string `json:"apiKey"`
	AuthDomain        string `json:"authDomain"`
	ProjectID         string `json:"projectId"`
	AppID             string `json:"appId"`
	MessagingSenderID string `json:"messagingSenderId"`
}

// Hosted is the hosted service's web config.
var Hosted = Firebase{
	APIKey:            "AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4",
	AuthDomain:        "hivenod.com",
	ProjectID:         "hive-board-43be",
	AppID:             "1:493986079810:web:71cf28f12f79f3cf9bf9db",
	MessagingSenderID: "493986079810",
}

// Emulators are local emulator addresses (host:port), honoured only for a site on this machine.
type Emulators struct {
	Auth      string `json:"auth,omitempty"`
	Firestore string `json:"firestore,omitempty"`
}

// Discovery is a parsed discovery file.
type Discovery struct {
	Protocol  int        `json:"protocol"`
	Backend   string     `json:"backend"`
	Site      string     `json:"site"`
	Firebase  Firebase   `json:"firebase"`
	CLI       string     `json:"cli"`
	Emulators *Emulators `json:"emulators,omitempty"`
}

// Error is a discovery problem; Code matches the TypeScript DiscoveryErrorCode.
type Error struct {
	Code string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func errf(code, format string, a ...any) error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

var (
	schemeRe = regexp.MustCompile(`(?i)^[a-z][a-z0-9+.-]*://`)
	hostPort = regexp.MustCompile(`^(localhost|127\.0\.0\.1|\[::1\]):(\d{1,5})$`)
)

func loopbackHost(h string) bool {
	switch strings.ToLower(h) {
	case "localhost", "127.0.0.1", "::1", "[::1]":
		return true
	}
	return false
}

// IsLoopback tells whether an address is on this machine.
func IsLoopback(site string) bool {
	u, err := url.Parse(site)
	return err == nil && loopbackHost(u.Hostname())
}

// NormalizeSite is the canonical form of a site address: https (http only on this machine), no
// credentials, query or fragment, no trailing slash. "your.host" means https://your.host.
func NormalizeSite(raw string) (string, error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "", errf("bad-site", "The server address is empty.")
	}
	if !schemeRe.MatchString(s) {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return "", errf("bad-site", "%q is not a web address.", raw)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		return "", errf("bad-site", "%q is not a web address (use https://…).", raw)
	}
	if u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Hostname() == "" {
		return "", errf("bad-site", "%q must be just the site address, like https://your.host.", raw)
	}
	if scheme == "http" && !loopbackHost(u.Hostname()) {
		return "", errf("insecure-site", "%q uses http; Hivenod sites must use https (http only for localhost).", raw)
	}
	host := strings.ToLower(u.Host)
	// Default ports are dropped, as browsers (and the TypeScript URL) do.
	if (scheme == "https" && strings.HasSuffix(host, ":443")) || (scheme == "http" && strings.HasSuffix(host, ":80")) {
		host = host[:strings.LastIndex(host, ":")]
	}
	return scheme + "://" + host + strings.TrimRight(u.EscapedPath(), "/"), nil
}

// URL of the discovery file of a site.
func URL(site string) (string, error) {
	s, err := NormalizeSite(site)
	if err != nil {
		return "", err
	}
	return s + Path, nil
}

// IsHosted tells whether a site is the hosted service.
func IsHosted(site string) bool {
	s, err := NormalizeSite(site)
	return err == nil && s == HostedSite
}

func str(v any) string {
	if s, ok := v.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

// Parse reads a discovery file (already JSON-decoded) fetched from site. Unknown fields are ignored.
func Parse(site string, doc any) (*Discovery, error) {
	base, err := NormalizeSite(site)
	if err != nil {
		return nil, err
	}
	m, ok := doc.(map[string]any)
	if !ok || m["service"] != "hivenod" {
		return nil, errf("not-hivenod", "%s does not look like a Hivenod site.", base)
	}
	p, ok := m["protocol"].(float64)
	if !ok || p != float64(int(p)) || p < 1 {
		return nil, errf("not-hivenod", "%s does not look like a Hivenod site.", base)
	}
	if int(p) > Protocol {
		return nil, errf("newer-protocol", "%s needs a newer hivenod CLI (protocol %d); run `hivenod update`.", base, int(p))
	}
	if b, has := m["backend"]; has && b != "firestore" {
		return nil, errf("unknown-backend", "%s uses a backend this CLI does not know (%v); run `hivenod update`.", base, b)
	}
	fb, _ := m["firebase"].(map[string]any)
	f := Firebase{
		APIKey:            str(fb["apiKey"]),
		AuthDomain:        str(fb["authDomain"]),
		ProjectID:         str(fb["projectId"]),
		AppID:             str(fb["appId"]),
		MessagingSenderID: str(fb["messagingSenderId"]),
	}
	for _, kv := range [][2]string{{"apiKey", f.APIKey}, {"authDomain", f.AuthDomain}, {"projectId", f.ProjectID}} {
		if kv[1] == "" {
			return nil, errf("missing-field", "%s%s has no firebase.%s.", base, Path, kv[0])
		}
	}
	cli, err := resolveCLI(base, str(m["cli"]))
	if err != nil {
		return nil, errf("bad-cli", "%s%s has an unusable cli address.", base, Path)
	}
	d := &Discovery{Protocol: int(p), Backend: "firestore", Site: base, Firebase: f, CLI: cli}
	if IsLoopback(base) {
		if em, ok := m["emulators"].(map[string]any); ok {
			e := Emulators{}
			if v := str(em["auth"]); hostPort.MatchString(v) {
				e.Auth = v
			}
			if v := str(em["firestore"]); hostPort.MatchString(v) {
				e.Firestore = v
			}
			if e.Auth != "" || e.Firestore != "" {
				d.Emulators = &e
			}
		}
	}
	return d, nil
}

func resolveCLI(base, ref string) (string, error) {
	if ref == "" {
		ref = "cli"
	}
	b, err := url.Parse(base + "/")
	if err != nil {
		return "", err
	}
	r, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	u := b.ResolveReference(r)
	scheme := strings.ToLower(u.Scheme)
	if u.User != nil || u.Host == "" || !(scheme == "https" || (scheme == "http" && loopbackHost(u.Hostname()))) {
		return "", fmt.Errorf("scheme")
	}
	return scheme + "://" + strings.ToLower(u.Host) + strings.TrimRight(u.EscapedPath(), "/"), nil
}

// Client is the HTTP client Fetch uses (tests swap it).
var Client = &http.Client{Timeout: 15 * time.Second}

// Fetch downloads and parses the discovery file of a site.
func Fetch(ctx context.Context, site string) (*Discovery, error) {
	base, err := NormalizeSite(site)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+Path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := Client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach %s: %w", base, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, errf("not-hivenod", "%s does not look like a Hivenod site (%s answered %d).", base, Path, res.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if err != nil {
		return nil, fmt.Errorf("could not read %s%s: %w", base, Path, err)
	}
	var doc any
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, errf("not-hivenod", "%s does not look like a Hivenod site (%s is not JSON).", base, Path)
	}
	return Parse(base, doc)
}
