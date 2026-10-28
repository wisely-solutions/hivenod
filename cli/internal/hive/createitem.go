package hive

import (
	"context"
	"fmt"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/actions"
	"github.com/wisely-solutions/hivenod/cli/internal/attachfile"
	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// MaxCreateAttachments bounds the files of one create_item call.
const MaxCreateAttachments = 10

// CreateItemOut is create_item's answer.
type CreateItemOut struct {
	ItemID      string      `json:"itemId"`
	ProjectID   string      `json:"projectId"`
	Project     string      `json:"project"`
	Step        string      `json:"step"`
	Status      string      `json:"status"`
	Attachments []AttachOut `json:"attachments"`
	// AttachErrors: files that could not be attached (the item exists anyway).
	AttachErrors []string `json:"attachErrors,omitempty"`
	Note         string   `json:"note"`
}

// CreateProjectDenied is the refusal when the rules turn a create down.
const CreateProjectDenied = `Hivenod refused to create the item: the project must allow it ("Agents may create items", switched on by an admin or the project creator) and this agent must be allowed on the project in its own organization.`

// limiter is the agent's create rate limit (item DhsO9).
func (c *Client) limiter() *CreateLimiter {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.Creates == nil {
		c.Creates = NewCreateLimiter()
	}
	return c.Creates
}

// ResolveProject is the id of a project this agent may use, given its id or its exact name
// (any case); else a clear error listing its projects.
func (c *Client) ResolveProject(ctx context.Context, idOrName string) (string, model.Project, error) {
	ids, err := c.projectIDs(ctx)
	if err != nil {
		return "", model.Project{}, err
	}
	projects := map[string]model.Project{}
	var names []string
	for _, pid := range ids {
		p, err := c.getProject(ctx, pid)
		if err != nil {
			continue
		}
		projects[pid] = p
		names = append(names, p.Name)
	}
	if p, ok := projects[idOrName]; ok {
		return idOrName, p, nil
	}
	var hit []string
	for pid, p := range projects {
		if strings.EqualFold(p.Name, idOrName) {
			hit = append(hit, pid)
		}
	}
	if len(hit) == 1 {
		return hit[0], projects[hit[0]], nil
	}
	list := ": it has no projects yet"
	if len(names) > 0 {
		list = ". Its projects: " + strings.Join(names, ", ")
	}
	return "", model.Project{}, Errf(fmt.Sprintf("This agent cannot use the project %q%s.", idOrName, list))
}

// CreateItem creates an item as this agent (item DhsO9): ordinary work at the project's first
// step, in a project that allows it, at most CreateItemLimit an hour. Files are attached right
// after; one that fails is reported, the item stays.
func (c *Client) CreateItem(ctx context.Context, project, title, description string, attachments []string) (CreateItemOut, error) {
	if _, err := c.requireNotPaused(ctx); err != nil {
		return CreateItemOut{}, err
	}
	title = jsTrim(title)
	if title == "" {
		return CreateItemOut{}, Errf("An item needs a title.")
	}
	if len([]rune(title)) > 300 || len([]rune(description)) > 20000 {
		return CreateItemOut{}, Errf("The title is at most 300 characters and the description at most 20000.")
	}
	if len(attachments) > MaxCreateAttachments {
		return CreateItemOut{}, Errf(fmt.Sprintf("At most %d attachments per item; attach the rest with attach.", MaxCreateAttachments))
	}
	if strings.TrimSpace(project) == "" {
		return CreateItemOut{}, Errf("Name the project (its id or its name).")
	}
	pid, p, err := c.ResolveProject(ctx, project)
	if err != nil {
		return CreateItemOut{}, err
	}
	if !actions.AgentsMayCreateItems(p) {
		return CreateItemOut{}, Errf(actions.AgentCreateOffMessage)
	}
	lim := c.limiter()
	if err := lim.Check(c.UID); err != nil {
		return CreateItemOut{}, err
	}
	summary := description
	unshaped := p.ShapeNewItems != nil && *p.ShapeNewItems
	r, err := actions.CreateItem(c.actx(), actions.CreateItemInput{Project: p, ProjectID: pid, Title: title, Type: "task", Summary: &summary, Unshaped: unshaped})
	if err != nil {
		return CreateItemOut{}, wrap(err)
	}
	if err := applyCreate(ctx, c, r); err != nil {
		return CreateItemOut{}, err
	}
	lim.Record(c.UID)
	c.mu.Lock()
	c.itemProject[r.ItemID] = pid
	c.mu.Unlock()
	first := p.Steps[0]
	out := CreateItemOut{ItemID: r.ItemID, ProjectID: pid, Project: p.Name, Step: first.Name, Status: "queued", Attachments: []AttachOut{}}
	switch {
	case unshaped:
		out.Note = fmt.Sprintf("Created in %s. It waits at %s to be shaped (an agent picks its steps), then goes through its path like any item.", p.Name, first.Name)
	case first.Kind == "human":
		out.Status = "waiting"
		out.Note = fmt.Sprintf("Created in %s. It waits at %s for people to decide.", p.Name, first.Name)
	default:
		out.Note = fmt.Sprintf("Created in %s at %s: it is work now, and any agent of that step can claim it (also you).", p.Name, first.Name)
	}
	for _, src := range attachments {
		a, err := c.attachNew(ctx, pid, r.ItemID, src)
		if err != nil {
			out.AttachErrors = append(out.AttachErrors, fmt.Sprintf("%s: %s", src, Message(err)))
			continue
		}
		out.Attachments = append(out.Attachments, a)
	}
	return out, nil
}

func applyCreate(ctx context.Context, c *Client, r actions.ItemResult) error {
	if err := c.Write(ctx, r.Plan, nil); err != nil {
		var he *Error
		if e, ok := err.(*Error); ok {
			he = e
		}
		// A refusal on a create is about the project, not an item: say so.
		if he != nil && strings.HasPrefix(he.Msg, "Hivenod refused this change") {
			return Errf(CreateProjectDenied)
		}
		return err
	}
	return nil
}

// attachNew attaches a file to an item this agent just created (no run: nobody holds it).
func (c *Client) attachNew(ctx context.Context, pid, itemID, source string) (AttachOut, error) {
	prep, err := attachfile.Prepare(source, "", nil)
	if err != nil {
		if attachfile.IsAttachError(err) {
			return AttachOut{}, Errf(err.Error())
		}
		return AttachOut{}, err
	}
	in := actions.AttachInput{ProjectID: pid, ItemID: itemID, Kind: prep.Kind, Name: prep.Name}
	if prep.HasURL {
		in.URL = sp(prep.URL)
	} else {
		in.Content = sp(prep.Content)
	}
	p, err := actions.Attach(c.actx(), in)
	if err != nil {
		return AttachOut{}, wrap(err)
	}
	if err := c.Write(ctx, p.Plan, nil); err != nil {
		return AttachOut{}, err
	}
	return AttachOut{AttachmentID: p.AttachmentID, Name: prep.Name, Kind: prep.Kind}, nil
}
