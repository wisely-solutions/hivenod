package hive

import (
	"context"
	"strings"

	"github.com/wisely-solutions/hivenod/cli/internal/model"
)

// InboxScopeToolPrefixes are the tools an Inbox-only agent may use (item fJnu6). Mirrors
// INBOX_SCOPE_TOOL_PREFIXES in packages/shared/src/agents.ts.
var InboxScopeToolPrefixes = []string{"inbox_", "thread_", "subject_", "outcome_"}

// InboxScopeRefusal mirrors INBOX_SCOPE_REFUSAL in packages/shared/src/agents.ts.
const InboxScopeRefusal = `This agent is limited to Inbox (scope "inbox"): it cannot work on development items. Use the inbox tools.`

// ToolInScope reports whether an agent of this scope may call the tool.
func ToolInScope(a model.Agent, tool string) bool {
	if !a.InboxOnly() {
		return true
	}
	for _, p := range InboxScopeToolPrefixes {
		if strings.HasPrefix(tool, p) {
			return true
		}
	}
	return false
}

// scoped refuses a tool outside the agent's scope before it runs (the rules refuse it anyway).
func scoped(name string, run Run) Run {
	return func(ctx context.Context, c *Client, a Args) (any, error) {
		if !ToolInScope(c.Agent(), name) {
			return nil, Errf(InboxScopeRefusal)
		}
		return run(ctx, c, a)
	}
}
