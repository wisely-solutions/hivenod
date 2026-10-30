package actions

// Thread attachments (item OE8FmrTaIxFVGcaeGG3N, slice 4): the Go port of
// packages/shared/src/threadattach.ts. The home agent attaches files to its thread
// (thread_attach), inline, under {threadId}_{id}; images only PNG, JPEG or WebP; links https.

import (
	"regexp"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
	"github.com/wisely-solutions/hivenod/cli/internal/plan"
)

var (
	// ThreadImageRe is THREAD_IMAGE_RE: a PNG, JPEG or WebP data URL (never SVG).
	ThreadImageRe       = regexp.MustCompile(`^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$`)
	attachmentSuffixRe  = regexp.MustCompile(`^[A-Za-z0-9]{1,40}$`)
	threadAttachKinds   = []string{"html", "markdown", "text", "image", "pdf", "link"}
	threadAttachHTTPSRe = regexp.MustCompile(`^https://\S+$`)
)

// ThreadAttachmentPath is threadAttachmentPath.
func ThreadAttachmentPath(w, aid string) string {
	return "workspaces/" + w + "/inboxAttachments/" + aid
}

// IsThreadAttachmentOf is isThreadAttachmentOf: aid names an attachment of thread threadID.
func IsThreadAttachmentOf(aid, threadID string) bool {
	return strings.HasPrefix(aid, threadID+"_") && attachmentSuffixRe.MatchString(aid[len(threadID)+1:])
}

// ThreadAttachInput is threadAttach's input.
type ThreadAttachInput struct {
	ThreadID string      `json:"threadId"`
	Thread   ThreadState `json:"thread"`
	// ID is its own id (after {threadId}_); a new one when empty.
	ID      string  `json:"id,omitempty"`
	Kind    string  `json:"kind"`
	Name    string  `json:"name"`
	Content *string `json:"content,omitempty"`
	URL     *string `json:"url,omitempty"`
}

// ThreadAttachResult is the plan and the attachment's id.
type ThreadAttachResult struct {
	plan.Plan
	AttachmentID string `json:"attachmentId"`
}

// ThreadAttach is threadAttach: one batch, the attachment and one thread.attached event.
func ThreadAttach(ctx Ctx, in ThreadAttachInput) (ThreadAttachResult, error) {
	if err := RequireAgent(ctx); err != nil {
		return ThreadAttachResult{}, err
	}
	t := in.Thread
	if t.FetchedBy != ctx.Actor.ID {
		return ThreadAttachResult{}, fail("Only the thread's home agent (the one that brought it in) attaches files to it.")
	}
	own := in.ID
	if own == "" {
		own = ctx.nid()
	}
	if !attachmentSuffixRe.MatchString(own) {
		return ThreadAttachResult{}, fail("id: 1 to 40 letters or digits")
	}
	attachmentID := in.ThreadID + "_" + own
	name := jsTrim(in.Name)
	if name == "" || jsLen(name) > 200 {
		return ThreadAttachResult{}, fail("name: 1 to 200 characters")
	}
	known := false
	for _, k := range threadAttachKinds {
		known = known || k == in.Kind
	}
	if !known {
		return ThreadAttachResult{}, fail("kind: one of " + strings.Join(threadAttachKinds, ", "))
	}
	var content, url any
	bytes := 0
	if in.Kind == "link" {
		u := ""
		if in.URL != nil {
			u = jsTrim(*in.URL)
		}
		if !threadAttachHTTPSRe.MatchString(u) || jsLen(u) > 2048 {
			return ThreadAttachResult{}, fail("A link needs an https URL")
		}
		url = u
	} else {
		if in.Content == nil {
			return ThreadAttachResult{}, fail("Attachment content missing")
		}
		c := *in.Content
		if in.Kind == "image" && !ThreadImageRe.MatchString(c) {
			return ThreadAttachResult{}, fail("An image is a PNG, JPEG or WebP file.")
		}
		content = c
		bytes = len(strings.ToValidUTF8(c, "�"))
	}
	if bytes > model.MaxAttachmentBytes {
		return ThreadAttachResult{}, fail("Attachments over 900 KB must be attached as a link")
	}
	p := InboxPlan(ctx, "thread.attached", t.MemberUID, sp(in.ThreadID), t.SubjectID,
		map[string]any{"attachmentId": attachmentID, "name": name, "kind": in.Kind},
		func(eventID string) []plan.Op {
			return []plan.Op{{Kind: "set", Path: ThreadAttachmentPath(ctx.WorkspaceID, attachmentID), Data: map[string]any{
				"memberUid": t.MemberUID, "threadId": in.ThreadID, "kind": in.Kind, "name": name,
				"content": content, "url": url, "bytes": int64(bytes), "by": ctx.Actor.ID,
				"at": ServerTime(), "lastEventId": eventID,
			}}}
		}, "")
	return ThreadAttachResult{Plan: p, AttachmentID: attachmentID}, nil
}
