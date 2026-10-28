// Package hive is the agent client of the Go CLI (packages/agent/src/client.ts): it signs in
// with the agent token and does every agent operation through the shared action plans, so each
// write is one batch (domain change + event) and firestore.rules enforce the rest.
package hive

import (
	"os"
)

// Public web config (not a secret); security is enforced by firestore.rules. Defaults are the
// hosted service (https://hivenod.com); a self-hosted install sets the HIVENOD_FIREBASE_* variables.
const (
	defaultAPIKey  = "AIzaSyCmFfvMHbbGr3lGdc_DefEkomtUOaLH6J4"
	defaultProject = "hive-board-43be"
	defaultWebURL  = "https://hivenod.com"
)

// Config is where Hivenod is.
type Config struct {
	APIKey       string
	ProjectID    string
	AuthEmulator string
	FSEmulator   string
	WebURL       string
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
