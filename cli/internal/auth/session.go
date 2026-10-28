// Package auth signs an agent in with Firebase Auth's REST API (identitytoolkit) using the
// email/password inside its token, and keeps a fresh ID token (securetoken refresh), exactly as
// the Firebase JS SDK does for the TypeScript CLI. The ID token goes to Firestore as a bearer
// token, so firestore.rules apply to every read and write. Nothing here logs a secret.
package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RefreshMargin: an ID token is refreshed when it expires within this time.
var RefreshMargin = 5 * time.Minute

// Error is a Firebase Auth error code such as INVALID_LOGIN_CREDENTIALS or USER_DISABLED.
type Error struct {
	Code   string
	Status int
}

func (e *Error) Error() string { return "auth: " + e.Code }

// RateLimited reports whether Firebase Auth refused because of too many attempts.
func RateLimited(err error) bool {
	var ae *Error
	return errors.As(err, &ae) && strings.HasPrefix(ae.Code, "TOO_MANY_ATTEMPTS")
}

// Config says where Firebase Auth is.
type Config struct {
	APIKey string
	// Emulator is host:port of the Auth emulator ("" for production).
	Emulator string
	HTTP     *http.Client
}

func (c Config) base(host string) string {
	if c.Emulator != "" {
		return "http://" + c.Emulator + "/" + host
	}
	return "https://" + host
}

func (c Config) client() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return &http.Client{Timeout: 30 * time.Second}
}

// Session holds the signed-in agent's tokens and refreshes them on demand.
type Session struct {
	cfg      Config
	email    string
	password string

	mu      sync.Mutex
	uid     string
	idToken string
	refresh string
	expires time.Time
	// Refreshes counts successful refreshes (for tests and the spike log).
	Refreshes int
	// now is replaceable in tests.
	now func() time.Time
}

// SignIn signs in with email and password.
func SignIn(ctx context.Context, cfg Config, email, password string) (*Session, error) {
	s := &Session{cfg: cfg, email: email, password: password, now: time.Now}
	if err := s.signIn(ctx); err != nil {
		return nil, err
	}
	return s, nil
}

// UID is the agent's Firebase Auth uid.
func (s *Session) UID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.uid
}

// Expires is when the current ID token expires.
func (s *Session) Expires() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.expires
}

func (s *Session) signIn(ctx context.Context) error {
	body, _ := json.Marshal(map[string]any{"email": s.email, "password": s.password, "returnSecureToken": true})
	var out struct {
		IDToken      string `json:"idToken"`
		RefreshToken string `json:"refreshToken"`
		ExpiresIn    string `json:"expiresIn"`
		LocalID      string `json:"localId"`
	}
	u := s.cfg.base("identitytoolkit.googleapis.com") + "/v1/accounts:signInWithPassword?key=" + url.QueryEscape(s.cfg.APIKey)
	if err := s.post(ctx, u, "application/json", bytes.NewReader(body), &out); err != nil {
		return err
	}
	return s.set(out.LocalID, out.IDToken, out.RefreshToken, out.ExpiresIn)
}

func (s *Session) refreshNow(ctx context.Context) error {
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {s.refresh}}
	var out struct {
		IDToken      string `json:"id_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    string `json:"expires_in"`
		UserID       string `json:"user_id"`
	}
	u := s.cfg.base("securetoken.googleapis.com") + "/v1/token?key=" + url.QueryEscape(s.cfg.APIKey)
	if err := s.post(ctx, u, "application/x-www-form-urlencoded", strings.NewReader(form.Encode()), &out); err != nil {
		return err
	}
	if err := s.set(out.UserID, out.IDToken, out.RefreshToken, out.ExpiresIn); err != nil {
		return err
	}
	s.Refreshes++
	return nil
}

func (s *Session) set(uid, id, refresh, expiresIn string) error {
	secs, err := strconv.Atoi(expiresIn)
	if err != nil || id == "" || refresh == "" || uid == "" {
		return &Error{Code: "BAD_RESPONSE"}
	}
	s.uid, s.idToken, s.refresh = uid, id, refresh
	s.expires = s.now().Add(time.Duration(secs) * time.Second)
	return nil
}

func (s *Session) post(ctx context.Context, u, ctype string, body io.Reader, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, body)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", ctype)
	res, err := s.cfg.client().Do(req)
	if err != nil {
		// Never wrap the URL: it holds only the public API key, but keep messages short.
		return fmt.Errorf("auth: network: %w", unwrapURL(err))
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode != http.StatusOK {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		code := e.Error.Message
		if i := strings.IndexAny(code, " :"); i > 0 {
			code = code[:i]
		}
		if code == "" {
			code = "HTTP_" + strconv.Itoa(res.StatusCode)
		}
		return &Error{Code: code, Status: res.StatusCode}
	}
	return json.Unmarshal(data, out)
}

func unwrapURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// Token returns a valid ID token, refreshing it first when it is about to expire. A refresh that
// is refused (refresh token revoked or expired) falls back to signing in again with the password.
func (s *Session) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.now().Add(RefreshMargin).Before(s.expires) {
		return s.idToken, nil
	}
	err := s.refreshNow(ctx)
	var ae *Error
	if errors.As(err, &ae) && ae.Status >= 400 && ae.Status < 500 {
		err = s.signIn(ctx)
	}
	if err != nil {
		return "", err
	}
	return s.idToken, nil
}

// GetRequestMetadata implements grpc credentials.PerRPCCredentials.
func (s *Session) GetRequestMetadata(ctx context.Context, _ ...string) (map[string]string, error) {
	t, err := s.Token(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]string{"authorization": "Bearer " + t}, nil
}

// RequireTransportSecurity is false only so the same credentials work with the local emulator;
// the production connection is always TLS (see package store).
func (s *Session) RequireTransportSecurity() bool { return false }
