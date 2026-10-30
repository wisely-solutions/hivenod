package hive

import (
	"errors"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/wisely-solutions/hivenod/cli/internal/auth"
)

// Error is a message for people and agents: one clear sentence (errors.ts HiveError).
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// Errf makes an Error.
func Errf(msg string) error { return &Error{Msg: msg} }

// Messages first written for the former TypeScript client; the Go CLI owns them now.
const (
	RevokedMessage   = "This agent cannot use Hivenod: it was revoked, rotated, or is not allowed in this organization. Ask an admin for a new token."
	RateLimitMessage = "Firebase is limiting requests for a moment (rate limit, not a problem with your token). Wait a minute and try again."
	NotPairedMessage = "HIVENOD_TOKEN is not set and this terminal is not paired. Run `hivenod pair` to pair it with Hivenod, or set HIVENOD_TOKEN."
	BadTokenMessage  = "HIVENOD_TOKEN is not a valid Hivenod agent token (it starts with hive_agt_)."
	RejectedMessage  = "Hivenod rejected this token. The agent may have been revoked or rotated: ask an admin for a new one."
)

// Denied reports a Firestore permission-denied error.
func Denied(err error) bool { return status.Code(err) == codes.PermissionDenied }

// NotFound reports a Firestore not-found error.
func NotFound(err error) bool { return status.Code(err) == codes.NotFound }

// RateLimited reports Firebase asking to slow down.
func RateLimited(err error) bool {
	return auth.RateLimited(err) || status.Code(err) == codes.ResourceExhausted
}

// Message is the text shown for any error.
func Message(err error) string {
	var he *Error
	if errors.As(err, &he) {
		return he.Msg
	}
	if s, ok := status.FromError(err); ok && s.Code() != codes.Unknown {
		return s.Message()
	}
	return err.Error()
}
