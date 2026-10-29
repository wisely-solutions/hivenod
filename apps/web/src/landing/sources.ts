/**
 * The channels the landing page names for Inbox and Calendar (item x38DsNLjyh1rBTlkwMr5): only
 * ones an agent can really bring in today. Messages: the sources Hivenod knows (INBOX_SOURCES in
 * @hive/shared, kept in step by sources.test.ts; not imported here so the landing chunk stays
 * small). Calendar: Google Calendar, the one an agent syncs and books in (docs/INBOX.md).
 */
export const MESSAGE_SOURCES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'mail', label: 'Mail' },
  { id: 'teams', label: 'Teams' },
  { id: 'slack', label: 'Slack' },
  { id: 'jira', label: 'Jira' },
  { id: 'gitlab', label: 'GitLab' },
  { id: 'github', label: 'GitHub' },
  { id: 'telegram', label: 'Telegram' },
];

export const CALENDAR_SOURCES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'google', label: 'Google Calendar' },
];
