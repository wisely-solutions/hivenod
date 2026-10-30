# The Personal organization and the personal agent

Inbox item fJnu6, slice (c). A member's **Personal** organization holds their own Inbox. Their personal agent (a Claude Code session that already has the member's
own accounts, such as their mail) joins it as an **Inbox-only agent**. It brings the member's own
requests into the Personal Inbox.

Calendar was removed (item OE8FmrTaIxFVGcaeGG3N, slice 5), and so were projects and items (slice 11): there is no calendar sync, no
`calendar_*` tool and no `hivenod calendar` command any more. Stop any calendar sync routine the
agent runs. **Hivenod never connects to Google.**

## 1. Create the Personal organization

Either the member does it in the app (organization switcher, New organization, name it
"Personal"), or an operator does it for them, with their OK:

```sh
# dry run: prints the writes, changes nothing
node packages/notifier/dist/notifier.mjs personal-org --email <their sign-in email>
# then, with their OK
node packages/notifier/dist/notifier.mjs personal-org --email <their sign-in email> --apply
```

It uses the notifier's service account (`GOOGLE_APPLICATION_CREDENTIALS`, docs/NOTIFIER.md) and
writes exactly what the app writes when someone creates an organization: the organization, their
member card and a `workspace.created` event. It adds it to their switcher without switching them
to it, and refuses if they already own an organization with that name. `--uid` works instead of
`--email`, and `--name` sets another name.

## 2. Pair the personal agent, scoped to Inbox

On the personal agent's machine (its desk session):

1. `hivenod pair`. It prints a code and a link.
2. The member opens the link in Hivenod, **switches to the Personal organization first**, checks
   the terminal shown, names the agent (for example "Personal") and picks **Inbox
   only**. Then they press Pair this terminal.
3. Back in the terminal, `hivenod whoami` says
   `scope: Inbox only`.

An Inbox-only agent:

- uses only the Inbox tools (`inbox_*`, `thread_*`, `subject_*`, `outcome_*`, `plan_*`). Every other tool
  answers "This agent is limited to Inbox", whatever its settings say;
- is created by an admin only, and its scope never changes (not even on token rotation). To change the scope, connect a new
  agent.

Then add the Hivenod plugin to its Claude Code (`claude plugin marketplace add
wisely-solutions/hivenod`, `claude plugin install hivenod@hivenod`), or the plain MCP server
(`hivenod mcp`).
