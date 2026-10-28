// Package token decodes Hivenod agent tokens (packages/shared/src/token.ts):
//
//	hive_agt_<base64url(json{p: password, w: workspaceId, e: email})>
//
// Errors never contain the token.
package token

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

const Prefix = "hive_agt_"

var agentEmail = regexp.MustCompile(`^agent-[a-z0-9]{12}@agents\.hive-board\.app$`)

// ErrInvalid is returned for any token that cannot be used.
var ErrInvalid = errors.New("this is not a valid Hivenod agent token")

// Parts are the decoded token fields.
type Parts struct {
	Workspace string
	Email     string
	Password  string
}

// Decode checks and decodes a token (surrounding whitespace is ignored).
func Decode(tok string) (Parts, error) {
	t := strings.TrimSpace(tok)
	if !strings.HasPrefix(t, Prefix) {
		return Parts{}, ErrInvalid
	}
	body := t[len(Prefix):]
	for _, c := range body {
		if !(c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-' || c == '_') {
			return Parts{}, ErrInvalid
		}
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(body, "="))
	if err != nil || !utf8.Valid(raw) {
		return Parts{}, ErrInvalid
	}
	var v struct {
		W *string `json:"w"`
		E *string `json:"e"`
		P *string `json:"p"`
	}
	if err := json.Unmarshal(raw, &v); err != nil || v.W == nil || v.E == nil || v.P == nil {
		return Parts{}, ErrInvalid
	}
	w, e, p := *v.W, *v.E, *v.P
	if n := utf8.RuneCountInString(w); n < 1 || n > 128 {
		return Parts{}, ErrInvalid
	}
	if !agentEmail.MatchString(e) {
		return Parts{}, ErrInvalid
	}
	if n := utf8.RuneCountInString(p); n < 16 || n > 256 {
		return Parts{}, ErrInvalid
	}
	return Parts{Workspace: w, Email: e, Password: p}, nil
}
