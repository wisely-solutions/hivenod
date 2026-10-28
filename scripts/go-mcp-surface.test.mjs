// Keeps the Go CLI's embedded MCP surface (tools, schemas, instructions) identical to the
// TypeScript `hivenod mcp` (item zLwtX2WEEg3mER4CR74g). UPDATE_GO_CONTRACT=1 rewrites it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { mcpSurface } from '../packages/agent/src/surface.ts';

const file = join(import.meta.dirname, '../cli/internal/mcpserver/surface.json');

it('the Go MCP surface matches the TypeScript one', async () => {
  const now = `${JSON.stringify(await mcpSurface(), null, 2)}\n`;
  if (process.env.UPDATE_GO_CONTRACT === '1') writeFileSync(file, now);
  let committed = '';
  try {
    committed = readFileSync(file, 'utf8');
  } catch {
    /* missing: fails below */
  }
  expect(
    committed === now,
    `${file} is out of date: run UPDATE_GO_CONTRACT=1 pnpm test:scripts`,
  ).toBe(true);
}, 30_000);
