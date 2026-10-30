package hive

// Thread attachments (item OE8FmrTaIxFVGcaeGG3N, slice 4): thread_attach adds a file or a link to
// a thread this agent brought in; its id goes into a summary's image visuals.

import (
	"context"
	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/attachfile"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// ThreadAttachOut is thread_attach's answer.
type ThreadAttachOut struct {
	ThreadID     string `json:"threadId"`
	AttachmentID string `json:"attachmentId"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Note         string `json:"note"`
}

// ThreadAttach attaches a file (inlined, up to 900 KB) or an https URL (a link) to the thread.
func (c *Client) ThreadAttach(ctx context.Context, threadID, source, name string) (ThreadAttachOut, error) {
	t, err := c.thread(ctx, threadID)
	if err != nil {
		return ThreadAttachOut{}, err
	}
	prep, err := attachfile.Prepare(source, name, nil)
	if err != nil {
		if attachfile.IsAttachError(err) {
			return ThreadAttachOut{}, Errf(err.Error())
		}
		return ThreadAttachOut{}, err
	}
	in := actions.ThreadAttachInput{ThreadID: threadID, Thread: actions.ThreadStateFrom(t), Kind: prep.Kind, Name: prep.Name}
	if prep.HasURL {
		in.URL = &prep.URL
	} else {
		in.Content = &prep.Content
	}
	r, err := actions.ThreadAttach(c.actx(), in)
	if err != nil {
		return ThreadAttachOut{}, wrap(err)
	}
	if err := c.inboxWrite(ctx, r.Plan); err != nil {
		return ThreadAttachOut{}, err
	}
	note := "Attached: the person sees it in the thread's Everything."
	if prep.Kind == "image" {
		note = `Attached: show it in thread_summary as {"kind": "image", "attachment": "` + r.AttachmentID + `"}, or as before or after of an image_pair.`
	}
	return ThreadAttachOut{ThreadID: threadID, AttachmentID: r.AttachmentID, Name: prep.Name, Kind: prep.Kind, Note: note}, nil
}

// threadAttachmentKinds is {attachment id: kind} of the thread's attachments (only their kinds read).
func (c *Client) threadAttachmentKinds(ctx context.Context, threadID string) (map[string]string, error) {
	q := c.DB.Collection(model.Paths.InboxCollection(c.WorkspaceID, "inboxAttachments")).
		Where("threadId", "==", threadID).Select("kind")
	docs, err := q.Documents(ctx).GetAll()
	if err != nil {
		return nil, c.inboxRead(err)
	}
	out := map[string]string{}
	for _, d := range docs {
		k, _ := d.Data()["kind"].(string)
		out[d.Ref.ID] = k
	}
	return out, nil
}
