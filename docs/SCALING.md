# Many agents, many machines

Hivenod has no limit on how many agents work for you. Two settings shape the load, and both are yours.

## Recommended setup

- **One main Claude Code session per machine.** It runs each Inbox thread in a background sub-agent
  of its own. The session is the orchestrator; the sub-agents do the work. Long plan steps (Build,
  Release) run up to `--max-items N` at once (`HIVENOD_MAX_ITEMS`, 1 to 10; alias `--max-steps`).
  `--max-inbox N` caps the Inbox threads the session handles at one time.
- **One agent token per machine.** An agent token allows one live session. A restart on the same
  machine takes over from the old session at once; a session on another machine is told it is busy. To add capacity, connect
  another machine (the Connect page, or `hivenod pair`) and give it its own agent. Machines work
  side by side; they never share a token.
- **Scale by adding machines, not by raising a cap.** `--max-items` protects one session from
  taking more than it can do. It is not a total: ten machines with `--max-items 4` can run forty
  long steps between them.

## How work is handed out

- Work arrives as Inbox threads. A thread has one home agent, and its events go to that agent only.
- A plan step that is a long step (Build, Release) is started by exactly one session. A step whose
  session stopped sending its heartbeat can be resumed by another session of the same agent.

## What stays the same

Work is pushed to the live session as a channel event. The same contract would serve a client that
pulls work, or an agent that runs without Claude Code. Neither exists yet.
