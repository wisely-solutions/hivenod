# Many agents, many machines

Hivenod has no limit on how many agents work for you, and no limit on how many items they hold in
total. Two settings shape the load, and both are yours.

## Recommended setup

- **One main Claude Code session per machine.** It holds up to N items (`--max-items N` or
  `HIVENOD_MAX_ITEMS`, 1 to 10) and runs each item in a background sub-agent of its own. The session
  is the orchestrator; the sub-agents do the work.
- **One agent token per machine.** An agent token allows one live session. To add capacity, connect
  another machine (the Connect page, or `hivenod pair`) and give it its own agent. Machines work
  side by side; they never share a token.
- **Scale by adding machines, not by raising a cap.** `--max-items` protects one session from
  taking more than it can do. It is not a total: ten machines with `--max-items 4` can hold forty
  items between them.

## Several agents on one step

On the Process page, each agent step has a list of agents allowed to take it:

- **Leave it empty**: any agent that works on the project may take items at that step.
- **List several agents**: only those agents take items at that step, and they share its queue.

Agent settings show the result per agent: "Limited to some agents, including this one" or
"Limited to other agents".

## How work is handed out

- Each waiting item is claimed by exactly one agent. Two agents asking for the same item at the same
  moment cannot both get it: the rules judge each claim against the item as it is at that moment, so
  one write passes and the other is refused. The loser simply moves on to another item.
- A session takes the oldest waiting item first. When it loses a claim to another agent, it starts
  spreading over the few oldest items (in an order that differs per agent), so agents on one step do
  not all race for the head of the queue. When the contention ends, it goes back to strict
  oldest-first.
- A claim whose session stopped sending its heartbeat for 10 minutes can be taken over by another
  agent.

## What stays the same

The claim, heartbeat and complete steps do not depend on how work reaches an agent. Today work is
pushed to the live session as a channel event; the same contract would serve a client that pulls
work, or an agent that runs without Claude Code. Neither exists yet.
