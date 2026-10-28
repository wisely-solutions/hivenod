package hive

import (
	"context"
	"regexp"
	"strings"
	"time"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

var dataURL = regexp.MustCompile(`(?s)^data:[^,]*;base64,(.*)$`)

// OriginalBytes: images and PDFs are stored as base64 data URLs; this is the file's own size.
func OriginalBytes(kind string, content *string, bytes int64) int64 {
	if kind != "image" && kind != "pdf" {
		return bytes
	}
	m := dataURL.FindStringSubmatch(str(content))
	if m == nil {
		return bytes
	}
	b64 := m[1]
	pad := 0
	if strings.HasSuffix(b64, "==") {
		pad = 2
	} else if strings.HasSuffix(b64, "=") {
		pad = 1
	}
	return int64(len(b64)*3/4) - int64(pad)
}

func nonNil[T any](xs []T) []T {
	if xs == nil {
		return []T{}
	}
	return xs
}

// ReadItem returns everything the next agent needs, including why people sent the item back.
func (c *Client) ReadItem(ctx context.Context, itemID, projectID string) (map[string]any, error) {
	l, err := c.load(ctx, itemID, projectID)
	if err != nil {
		return nil, err
	}
	base := "workspaces/" + c.WorkspaceID + "/projects/" + l.ProjectID
	attSnaps, err := allDocs(c.DB.Collection(base + "/items/" + itemID + "/attachments").Documents(ctx))
	if err != nil {
		return nil, c.read(ctx, err)
	}
	msgSnaps, err := allDocs(c.DB.Collection(base + "/items/" + itemID + "/messages").Documents(ctx))
	if err != nil {
		return nil, c.read(ctx, err)
	}
	decSnaps, err := allDocs(c.DB.Collection(base+"/decisions").Where("itemId", "==", itemID).Documents(ctx))
	if err != nil {
		return nil, c.read(ctx, err)
	}
	type idDec struct {
		id string
		d  model.Decision
	}
	var decs []idDec
	for _, s := range decSnaps {
		var d model.Decision
		if s.DataTo(&d) == nil {
			decs = append(decs, idDec{s.Ref.ID, d})
		}
	}
	sortByAt(decs, func(x idDec) time.Time { return x.d.At })
	item := l.Item
	var step any
	if s := findStep(l.Project, item.StepID); s != nil {
		step = map[string]any{"id": s.ID, "name": s.Name, "kind": s.Kind, "description": s.Description, "instructions": s.Instructions, "outputs": nonNil(s.Outputs)}
	}
	var claim any
	if item.Claim != nil {
		claim = map[string]any{"runId": item.Claim.RunID, "mine": item.Claim.AgentUID == c.UID}
	}
	var job, shape any
	if actions.IsUnshaped(item) {
		job = "shape"
	}
	if item.Shape != nil {
		shape = map[string]any{"by": item.Shape.By, "note": item.Shape.Note}
	}
	path := []map[string]any{}
	for _, p := range actions.StepsOnPath(l.Project, item) {
		row := map[string]any{"id": p.Step.ID, "name": p.Step.Name, "kind": p.Step.Kind, "description": p.Step.Description, "state": p.State}
		if p.Note != "" {
			row["skipReason"] = p.Note
		}
		if p.Request != "" {
			reason := ""
			if r, ok := item.PathRequests[p.Step.ID]; ok {
				reason = r.Reason
			}
			row["pending"] = map[string]any{"op": p.Request, "reason": reason}
		}
		if contains(item.PathRefused, p.Step.ID) {
			row["refused"] = true
		}
		path = append(path, row)
	}
	sendBackReasons := []map[string]any{}
	decisions := []map[string]any{}
	for _, x := range decs {
		d := x.d
		if d.Outcome == "sentBack" {
			sendBackReasons = append(sendBackReasons, map[string]any{"at": isoOrNull(d.At), "toStepId": d.ToStepID, "reason": d.Rationale, "tags": nonNil(d.Tags)})
		}
		decisions = append(decisions, map[string]any{"at": isoOrNull(d.At), "outcome": d.Outcome, "stepId": d.StepID, "toStepId": d.ToStepID, "byUid": d.ByUID, "rationale": d.Rationale, "tags": nonNil(d.Tags)})
	}
	type idMsg struct {
		id string
		m  model.Message
	}
	var msgs []idMsg
	for _, s := range msgSnaps {
		var m model.Message
		if s.DataTo(&m) == nil {
			msgs = append(msgs, idMsg{s.Ref.ID, m})
		}
	}
	sortByAt(msgs, func(x idMsg) time.Time { return x.m.At })
	messages := []map[string]any{}
	for _, x := range msgs {
		messages = append(messages, map[string]any{"id": x.id, "at": isoOrNull(x.m.At), "by": x.m.By, "kind": x.m.Kind, "text": x.m.Text, "answered": x.m.Answered})
	}
	type idAtt struct {
		id string
		a  model.Attachment
	}
	var atts []idAtt
	for _, s := range attSnaps {
		var a model.Attachment
		if s.DataTo(&a) == nil {
			atts = append(atts, idAtt{s.Ref.ID, a})
		}
	}
	sortByAt(atts, func(x idAtt) time.Time { return x.a.At })
	attachments := []map[string]any{}
	for _, x := range atts {
		a := x.a
		var content any
		if a.Kind == "html" || a.Kind == "markdown" || a.Kind == "text" {
			content = a.Content
		}
		row := map[string]any{"id": x.id, "at": isoOrNull(a.At), "name": a.Name, "kind": a.Kind, "bytes": OriginalBytes(a.Kind, a.Content, a.Bytes), "by": a.By, "url": a.URL, "content": content}
		attachments = append(attachments, row)
	}
	targets := []map[string]any{}
	for _, s := range actions.AgentSendBackTargets(l.Project, item) {
		targets = append(targets, map[string]any{"id": s.ID, "name": s.Name})
	}
	return map[string]any{
		"itemId":          itemID,
		"projectId":       l.ProjectID,
		"project":         l.Project.Name,
		"title":           item.Title,
		"type":            item.Type,
		"summary":         item.Summary,
		"status":          item.Status,
		"step":            step,
		"claim":           claim,
		"progress":        item.Progress,
		"costEur":         item.CostEur,
		"sendBackCount":   item.SendBackCount,
		"job":             job,
		"shape":           shape,
		"path":            path,
		"sendBackReasons": sendBackReasons,
		"agentSendBacks": map[string]any{
			"rounds":  actions.AgentRounds(item),
			"max":     model.MaxAgentSendBacks,
			"history": c.agentSendBacks(ctx, l),
			"targets": targets,
		},
		"decisions":   decisions,
		"messages":    messages,
		"attachments": attachments,
	}, nil
}
