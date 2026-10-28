// Package hive is the agent client of the Go CLI (packages/agent/src/client.ts): it signs in
// with the agent token and does every agent operation through the shared action plans, so each
// write is one batch (domain change + event) and firestore.rules enforce the rest.
package hive

import (
	"context"
	"os"

	"github.com/wisely-solutions/hivenod/cli/internal/credentials"
	"github.com/wisely-solutions/hivenod/cli/internal/discovery"
)

// Public web config (not a secret); security is enforced by firestore.rules. Defaults are the
// hosted service (https://hivenod.com). A self-hosted install gives its site's address
// (`--server`, HIVENOD_WEB_URL or the saved pairing) and the CLI reads the rest from the site's
// /.well-known/hivenod.json; the HIVENOD_FIREBASE_* variables still win when set.
const (
	defaultAPIKey  = "AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4"
	defaultProject = "hive-board-43be"
	defaultWebURL  = discovery.HostedSite
)

// Config is where Hivenod is.
type Config struct {
	APIKey       string
	ProjectID    string
	AuthEmulator string
	FSEmulator   string
	WebURL       string
	// Discovery is the site's discovery file when the config came from it (saved with the token).
	Discovery *discovery.Discovery
}

func env(k string) string { return os.Getenv(k) }

func first(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// FromEnv reads the same variables as the TypeScript CLI.
func FromEnv() Config {
	return Config{
		APIKey:       first(env("HIVENOD_FIREBASE_API_KEY"), defaultAPIKey),
		ProjectID:    first(env("HIVENOD_PROJECT_ID"), env("HIVENOD_FIREBASE_PROJECT_ID"), defaultProject),
		AuthEmulator: env("FIREBASE_AUTH_EMULATOR_HOST"),
		FSEmulator:   env("FIRESTORE_EMULATOR_HOST"),
		WebURL:       first(env("HIVENOD_WEB_URL"), defaultWebURL),
	}
}

// explicitEnv: the Firebase config (or emulators) is given by variables, as before discovery.
func explicitEnv() bool {
	for _, k := range []string{"HIVENOD_FIREBASE_API_KEY", "HIVENOD_FIREBASE_PROJECT_ID", "HIVENOD_PROJECT_ID", "FIREBASE_AUTH_EMULATOR_HOST", "FIRESTORE_EMULATOR_HOST"} {
		if env(k) != "" {
			return true
		}
	}
	return false
}

// Site is the Hivenod this command talks to: --server, then HIVENOD_WEB_URL, then the server
// saved with the token, then https://hivenod.com.
func Site(server string, saved *credentials.Stored) (string, error) {
	s := first(server, env("HIVENOD_WEB_URL"))
	if s == "" && saved != nil {
		s = saved.Server
	}
	if s == "" {
		return defaultWebURL, nil
	}
	return discovery.NormalizeSite(s)
}

// Resolve finds the config for a command. The hosted service and explicit HIVENOD_FIREBASE_*
// variables need no network; any other site is read from its discovery file, or from the copy
// saved with the token.
func Resolve(ctx context.Context, server string, saved *credentials.Stored) (Config, error) {
	site, err := Site(server, saved)
	if err != nil {
		return Config{}, Errf(err.Error())
	}
	if explicitEnv() || discovery.IsHosted(site) {
		c := FromEnv()
		c.WebURL = site
		return c, nil
	}
	d := (*discovery.Discovery)(nil)
	if saved != nil && saved.Server == site {
		d = saved.Discovery
	}
	if d == nil {
		if d, err = discovery.Fetch(ctx, site); err != nil {
			return Config{}, Errf(err.Error())
		}
	}
	return FromDiscovery(d), nil
}

// FromDiscovery is the config of a site described by its discovery file.
func FromDiscovery(d *discovery.Discovery) Config {
	c := Config{APIKey: d.Firebase.APIKey, ProjectID: d.Firebase.ProjectID, WebURL: d.Site, Discovery: d}
	if d.Emulators != nil {
		c.AuthEmulator, c.FSEmulator = d.Emulators.Auth, d.Emulators.Firestore
	}
	return c
}
