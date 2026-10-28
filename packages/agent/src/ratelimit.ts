/**
 * Item DhsO9: an agent creates at most CREATE_ITEM_LIMIT items per CREATE_ITEM_WINDOW_MS, so a loop
 * cannot flood a board. The limit lives in the agent's session code, like max_items (all agents are
 * their owner's own); the rules enforce who may create where. Mirrors cli/internal/hive/ratelimit.go.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hiveHome } from './credentials';
import { HiveError } from './errors';

export const CREATE_ITEM_LIMIT = 30;
export const CREATE_ITEM_WINDOW_MS = 60 * 60_000;

/** The refusal once the limit is reached; `nextMs` is when a slot frees. */
export function createRateMessage(limit: number, nextMs: number): string {
  const mins = Math.max(1, Math.ceil(nextMs / 60_000));
  return `Rate limit: this agent already created ${limit} items in the last hour (at most ${limit} per hour, so a loop cannot flood a board). The next one can be created in ${mins} ${mins === 1 ? 'minute' : 'minutes'}.`;
}

/**
 * Keeps the creations (ms) still inside the window and throws when the limit is reached. It never
 * records: call `record` after a successful create.
 */
export function checkCreateRate(
  times: readonly number[],
  nowMs: number,
  limit = CREATE_ITEM_LIMIT,
  windowMs = CREATE_ITEM_WINDOW_MS,
): number[] {
  const kept = times.filter((t) => t > nowMs - windowMs && t <= nowMs);
  if (kept.length >= limit)
    throw new HiveError(createRateMessage(limit, Math.min(...kept) + windowMs - nowMs));
  return kept;
}

/**
 * Counts this agent's creations, per agent, in a small file next to the token
 * (~/.hivenod/created-items.json), so separate CLI runs and MCP sessions on the machine share it.
 * Without a usable file it still counts in memory.
 */
export class CreateLimiter {
  private readonly mem = new Map<string, number[]>();
  constructor(
    readonly path: string | null = join(hiveHome(), 'created-items.json'),
    private readonly now: () => number = Date.now,
    readonly limit = CREATE_ITEM_LIMIT,
    readonly windowMs = CREATE_ITEM_WINDOW_MS,
  ) {}

  private load(): Record<string, number[]> {
    let all: Record<string, number[]> = {};
    if (this.path) {
      try {
        const v = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
        if (v && typeof v === 'object' && !Array.isArray(v)) all = v as Record<string, number[]>;
      } catch {
        /* no file yet, or unreadable: count from memory */
      }
    }
    for (const [k, v] of this.mem) if (v.length > (all[k]?.length ?? 0)) all[k] = v;
    return all;
  }

  /** Throws when the agent is at its limit. */
  check(agentUid: string): void {
    const times = this.load()[agentUid];
    checkCreateRate(Array.isArray(times) ? times : [], this.now(), this.limit, this.windowMs);
  }

  /** Counts one creation by the agent. */
  record(agentUid: string): void {
    const all = this.load();
    const now = this.now();
    const prev = Array.isArray(all[agentUid]) ? all[agentUid] : [];
    const kept = prev.filter((t) => t > now - this.windowMs && t <= now);
    all[agentUid] = [...kept, now];
    this.mem.set(agentUid, all[agentUid]);
    if (!this.path) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
      renameSync(tmp, this.path);
    } catch {
      /* the in-memory count still holds */
    }
  }
}
