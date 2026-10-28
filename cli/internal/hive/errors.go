package hive

import (
	"errors"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/wisely-solutions/hivenod/cli/internal/auth"
)

// Error is a message for people and agents: one clear sentence (errors.ts HiveError).
type Error struct{ Msg string }

func (e *Error) Error() string { return e.Msg }

// Errf makes an Error.
func Errf(msg string) error { return &Error{Msg: msg} }

// Messages shared with the TypeScript CLI (packages/agent/src/errors.ts, client.ts).
const (
	GateMessage        = "This item is at a human gate. Only people can move it."
	RevokedMessage     = "This agent cannot use Hivenod: it was revoked, rotated, or is not allowed in this organization. Ask an admin for a new token."
	RateLimitMessage   = "Firebase is limiting requests for a moment (rate limit, not a problem with your token). Wait a minute and try again."
	StoppedPrefix      = "People stopped this work in Hivenod"
	OnHoldMessage      = "People stopped the work on this item and put it on hold in Hivenod. No agent can claim it until someone presses Resume. Pick another item (hivenod work list)."
	StepLimitedMessage = "This step is limited to other agents in the project’s process. Pick another item (hivenod work list shows only what you may take)."
	HeldMessage        = "This item waits for people to answer a question in \"Needs you\" (asked when the last run gave it back). Nobody can claim it until it is answered. Pick another item (hivenod work list)."
	NotPairedMessage   = "HIVENOD_TOKEN is not set and this terminal is not paired. Run `hivenod pair` to pair it with Hivenod, or set HIVENOD_TOKEN."
	BadTokenMessage    = "HIVENOD_TOKEN is not a valid Hivenod agent token (it starts with hive_agt_)."
	RejectedMessage    = "Hivenod rejected this token. The agent may have been revoked or rotated: ask an admin for a new one."
)

// StoppedMessage: a person pressed Stop work on this item.
func StoppedMessage(summary string) string {
	s := StoppedPrefix
	if summary != "" {
		s += " (" + summary + ")"
	}
	return s + ". Stop working on this item; it is not yours any more."
}

// IsStopped reports whether an error is the stopped message.
func IsStopped(err error) bool { return err != nil && strings.HasPrefix(err.Error(), StoppedPrefix) }

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
