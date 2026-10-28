# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue or pull request.

Email **privacy@hivenod.com** with what you found, how to reproduce it, and what you think the impact is.
This is the project's one monitored address today, and the only channel for security reports (GitHub's
private vulnerability reporting is not enabled on this repository). A dedicated `security@hivenod.com`
alias may replace it later; this file will say so.

We aim to acknowledge a report within 3 working days and to tell you what we plan to do within 14 days.
Please give us a reasonable time to fix a problem before you publish it. We will credit you if you want.

## Scope

In scope: the app (https://hivenod.com), the Firestore security rules, the `hivenod` CLI and MCP server,
the channel plugin, and the code in this repository.

Out of scope: denial-of-service by volume, social engineering, and problems in Firebase or Google
services themselves (report those to Google).

Please do not access other people's data, and test only against your own workspace or the local emulators.

## What is public by design

The Firebase web config in `apps/web/src/lib/app.ts` (API key, project id, app id) is public by design:
it only identifies the project. Access is enforced by `firestore.rules`.
