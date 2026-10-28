# The Personal organization and the personal agent

Inbox item fJnu6, slice (c). A member's **Personal** organization holds their own Inbox and their
own calendar: no development projects. Their personal agent (a Claude Code session that already
has the member's own accounts, such as their Google Calendar and mail) joins it as an **Inbox and
Calendar agent**. It brings the member's own requests into the Personal Inbox and keeps their
Google Calendar synced into Hivenod, so drafts in every organization see their real free time.

**Hivenod never connects to Google.** The agent reads the calendar with its own access and hands
Hivenod the events; Hivenod plans and writes the changes.

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

## 2. Pair the personal agent, scoped to Inbox and Calendar

On the personal agent's machine (its desk session):

1. `hivenod pair`. It prints a code and a link.
2. The member opens the link in Hivenod, **switches to the Personal organization first**, checks
   the terminal shown, names the agent (for example "Personal") and picks **Inbox and Calendar
   only**. Then they press Pair this terminal.
3. Back in the terminal, `hivenod whoami` says
   `scope: Inbox and Calendar only (no development projects)`.

An Inbox and Calendar agent:

- uses only the Calendar tools (`calendar_*`) and the Inbox tools (`inbox_*`, `thread_*`,
  `subject_*`, `outcome_*`). Every other tool answers "This agent is limited to Inbox and
  Calendar", and the Firestore rules refuse it every project, item, claim, created item and
  finding, whatever its settings say;
- is created by an admin only, and its scope never changes (not even on token rotation). To make
  it a project agent, connect a new one.

Then add the Hivenod plugin to its Claude Code (`claude plugin marketplace add
wisely-solutions/hivenod`, `claude plugin install hivenod@hivenod`), or the plain MCP server
(`hivenod mcp`).

## 3. Sync the Google Calendar

The sync takes the events as the **Google Calendar API lists them**, with recurring events
expanded (`singleEvents=true`). It saves new and changed events and removes cancelled ones, ones
the member declined, ones shown as free (Google's default for all-day events) and working-location
entries. In a **full** sync (the default) an event no longer listed in the window is removed too.
In an **incremental** sync (`--incremental`), only what changed since the last sync token is
given, and nothing is removed for being absent. Only changes are written. All-day dates are taken
as UTC days.

The default window is from a day ago to 30 days ahead (`--from`/`--to` change it, up to 62
days).

### Recipe (every 15 minutes, on the agent's own schedule)

1. **Read Google** with the agent's own access, for the window:
   `timeMin` = now − 1 day, `timeMax` = now + 30 days, `singleEvents=true`, `maxResults=2500`.
   Save the response (`{"items": [...], "nextSyncToken": "…"}`) as JSON, for example
   `~/.hivenod/gcal.json`. A plain array of events works too.
2. **Sync it into Hivenod**, in the Personal organization:

   ```sh
   hivenod calendar sync ~/.hivenod/gcal.json --source google --state ~/.hivenod/google-sync.json
   ```

   It prints what it did ("Synced google (full): 2 added or updated, 1 removed, 31 unchanged")
   and the events it skipped, with the reason. `--json` gives the same as JSON.

3. **Incremental, when the Google access gives sync tokens:** `--state` keeps Google's
   `nextSyncToken` (mode 600, nothing else). Next time, list with `syncToken` = that token (no
   `timeMin`/`timeMax`), and sync with `--incremental`. When Google answers 410 Gone, do a full
   sync again. Do a full sync at least once a day anyway: it also catches anything missed.
   When the Google tool gives no token (most MCP calendar tools), just do full syncs: they write
   only what changed.

The same from MCP, without a file: the tool `calendar_sync` takes `events` (the Google items),
plus `from`, `to`, `incremental`, `busyOnly` and `nextSyncToken`. Use the file for large
calendars.

`--busy-only` keeps only the times (no titles or attendees) in Hivenod. In the Personal
organization, only the member sees the details anyway; every other organization they are in sees
only "busy" (the busy store holds no titles).

### Check it

- The member's Calendar view in Hivenod shows the events in the Personal organization, and
  "busy" blocks in their other organizations.
- An agent of another organization: `calendar_free` for the member shows the synced time as busy.
- To clear the synced events of the window: `echo '[]' | hivenod calendar sync -`.

## Later (not built yet)

Mirroring bookings to Google: after the member's OK on a `reply_book` outcome in a Personal
thread, the personal agent creates the event in Google with its own access and reports it done
(`outcome_done`). It waits for Inbox (a)'s outcomes executor and Calendar (b) part 3.
