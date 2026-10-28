package model

import "fmt"

type pathBuilders struct{}

// Paths builds document paths, like `paths` in schema.ts.
var Paths pathBuilders

func (pathBuilders) User(u string) string      { return "users/" + u }
func (pathBuilders) Workspace(w string) string { return "workspaces/" + w }
func (pathBuilders) Member(w, u string) string { return "workspaces/" + w + "/members/" + u }
func (pathBuilders) Invite(w, code string) string {
	return "workspaces/" + w + "/invites/" + code
}
func (pathBuilders) Group(w, g string) string   { return "workspaces/" + w + "/groups/" + g }
func (pathBuilders) Agent(w, a string) string   { return "workspaces/" + w + "/agents/" + a }
func (pathBuilders) Project(w, p string) string { return "workspaces/" + w + "/projects/" + p }
func (pathBuilders) Item(w, p, i string) string {
	return "workspaces/" + w + "/projects/" + p + "/items/" + i
}
func (pathBuilders) Attachment(w, p, i, a string) string {
	return "workspaces/" + w + "/projects/" + p + "/items/" + i + "/attachments/" + a
}
func (pathBuilders) Message(w, p, i, m string) string {
	return "workspaces/" + w + "/projects/" + p + "/items/" + i + "/messages/" + m
}
func (pathBuilders) StepProposal(w, p, s string) string {
	return "workspaces/" + w + "/projects/" + p + "/stepProposals/" + s
}
func (pathBuilders) Decision(w, p, d string) string {
	return "workspaces/" + w + "/projects/" + p + "/decisions/" + d
}
func (pathBuilders) Run(w, r string) string { return "workspaces/" + w + "/runs/" + r }
func (pathBuilders) LogLine(w, r string, n int) string {
	return fmt.Sprintf("workspaces/%s/runs/%s/log/%d", w, r, n)
}
func (pathBuilders) Event(w, e string) string { return "workspaces/" + w + "/events/" + e }

// DeleteEventID is the deterministic tombstone event id of a hard delete
// (kind: groups, invites, projects or items).
func (pathBuilders) DeleteEventID(kind, docID string) string { return "del-" + kind + "-" + docID }

// Inbox (item 4PEHrOW5IfXBQWgOK9wo): inboxPaths in packages/shared/src/inbox.ts.
func (pathBuilders) InboxSubject(w, s string) string {
	return "workspaces/" + w + "/inboxSubjects/" + s
}
func (pathBuilders) InboxThread(w, t string) string { return "workspaces/" + w + "/inboxThreads/" + t }
func (pathBuilders) InboxMessage(w, m string) string {
	return "workspaces/" + w + "/inboxMessages/" + m
}
func (pathBuilders) InboxOutcome(w, o string) string {
	return "workspaces/" + w + "/inboxOutcomes/" + o
}
func (pathBuilders) InboxEvent(w, e string) string { return "workspaces/" + w + "/inboxEvents/" + e }

// InboxCollection is workspaces/{w}/<name> (inboxThreads, inboxMessages, …).
func (pathBuilders) InboxCollection(w, name string) string { return "workspaces/" + w + "/" + name }
