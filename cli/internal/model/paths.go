package model

type pathBuilders struct{}

// Paths builds document paths, like `paths` in schema.ts.
var Paths pathBuilders

func (pathBuilders) User(u string) string      { return "users/" + u }
func (pathBuilders) Workspace(w string) string { return "workspaces/" + w }
func (pathBuilders) Member(w, u string) string { return "workspaces/" + w + "/members/" + u }
func (pathBuilders) Invite(w, code string) string {
	return "workspaces/" + w + "/invites/" + code
}
func (pathBuilders) Group(w, g string) string { return "workspaces/" + w + "/groups/" + g }
func (pathBuilders) Agent(w, a string) string { return "workspaces/" + w + "/agents/" + a }

// Inbox (item 4PEHrOW5IfXBQWgOK9wo): inboxPaths in packages/shared/src/inbox.ts.
func (pathBuilders) InboxSubject(w, s string) string {
	return "workspaces/" + w + "/inboxSubjects/" + s
}

// InboxLabels is the workspace's label list (inboxPaths.labels).
func (pathBuilders) InboxLabels(w string) string    { return "workspaces/" + w + "/inboxConfig/labels" }
func (pathBuilders) InboxThread(w, t string) string { return "workspaces/" + w + "/inboxThreads/" + t }
func (pathBuilders) InboxMessage(w, m string) string {
	return "workspaces/" + w + "/inboxMessages/" + m
}
func (pathBuilders) InboxOutcome(w, o string) string {
	return "workspaces/" + w + "/inboxOutcomes/" + o
}
func (pathBuilders) InboxEvent(w, e string) string { return "workspaces/" + w + "/inboxEvents/" + e }
func (pathBuilders) InboxPlan(w, p string) string  { return "workspaces/" + w + "/inboxPlans/" + p }
func (pathBuilders) InboxRelation(w, r string) string {
	return "workspaces/" + w + "/inboxRelations/" + r
}

// InboxCollection is workspaces/{w}/<name> (inboxThreads, inboxMessages, …).
func (pathBuilders) InboxCollection(w, name string) string { return "workspaces/" + w + "/" + name }
