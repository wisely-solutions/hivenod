// Release smoke test of the Go CLI (item zLwtX2WEEg3mER4CR74g): what the site serves under
// /cli/bin must be what this release built (all five binaries: presence, size, SHA-256 against
// the manifest and the .sha256 files), install.sh/install.ps1 must be served, and the linux-x64
// binary must work end to end: --version, `mcp --channel` initialize, and `pair` showing a
// pairing URL on this site (cancelled at once, which deletes its pairing request).
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { servedProblems, sha256 } from './cli-bin-lib.mjs';

const nocache = (u) => `${u}${u.includes('?') ? '&' : '?'}t=${Date.now()}`;

/** Runs the binary with stdin text; resolves when it exits or after ms (then kills it). */
function runBin(bin, args, { input = '', env = {}, ms = 20_000, onLine } = {}) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { PATH: process.env.PATH ?? '', ...env } });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), ms);
    child.stdout.on('data', (d) => {
      stdout += d;
      onLine?.(stdout, child);
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
    if (input) child.stdin.write(input);
    else child.stdin.end();
  });
}

/**
 * Checks the served CLI against the built manifest `m`. Returns the problems (empty = good).
 * `pair: false` skips the pairing check (tests); `env` is passed to the binary.
 */
export async function cliBinProblems(siteUrl, m, { pair = true, env = {}, fetchFn = fetch } = {}) {
  const problems = [];
  const get = async (path) => {
    const r = await fetchFn(nocache(`${siteUrl}${path}`), { cache: 'no-store' });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  };
  const manifestBytes = await get('/cli/bin/latest.json');
  let served = { manifest: null, files: {} };
  try {
    served.manifest = JSON.parse(String(manifestBytes));
  } catch {
    problems.push(`${siteUrl}/cli/bin/latest.json is not served`);
    return problems;
  }
  const bins = {};
  for (const [t, f] of Object.entries(m.files)) {
    const bytes = await get(f.path);
    const sum = await get(`${f.path}.sha256`);
    if (bytes) {
      served.files[t] = { size: bytes.length, sha256: sha256(bytes), sumFile: String(sum ?? '') };
      bins[t] = bytes;
    }
  }
  problems.push(...servedProblems(m, served));
  for (const p of ['/install.sh', '/install.ps1']) {
    const b = await get(p);
    const ok =
      b &&
      (p.endsWith('.sh') ? String(b).startsWith('#!/bin/sh') : String(b).includes('latest.json'));
    if (!ok) problems.push(`${siteUrl}${p} is not served`);
  }
  if (platform() !== 'linux' || arch() !== 'x64' || !bins['linux-x64']) {
    if (!bins['linux-x64']) problems.push('the linux-x64 binary could not be run (not served)');
    return problems;
  }
  const dir = mkdtempSync(join(tmpdir(), 'hivenod-smoke-'));
  try {
    const bin = join(dir, 'hivenod');
    writeFileSync(bin, bins['linux-x64']);
    chmodSync(bin, 0o755);
    const home = { HOME: dir, HIVENOD_HOME: join(dir, 'home'), ...env };
    const v = await runBin(bin, ['--version'], { env: home });
    if (!v.stdout.startsWith(`hivenod ${m.version} (commit ${m.commit.slice(0, 7)})`))
      problems.push(`hivenod --version says "${v.stdout.trim()}", built ${m.version}`);
    const init = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'release-smoke', version: '0' } } })}\n`;
    const mcp = await runBin(bin, ['mcp', '--channel'], {
      input: init,
      env: home,
      ms: 15_000,
      onLine: (out, child) => {
        if (out.includes('"id":1')) child.stdin.end();
      },
    });
    let reply = null;
    try {
      reply = JSON.parse(mcp.stdout.split('\n').find((l) => l.includes('"id":1')) ?? '');
    } catch {
      /* below */
    }
    if (
      reply?.result?.serverInfo?.name !== 'hivenod' ||
      !reply?.result?.capabilities?.experimental?.['claude/channel']
    )
      problems.push(
        `hivenod mcp --channel did not answer initialize (${mcp.stderr.trim() || mcp.stdout.slice(0, 200)})`,
      );
    if (pair) {
      let url = '';
      const p = await runBin(bin, ['pair'], {
        env: home,
        ms: 30_000,
        onLine: (out, child) => {
          const mm = /https?:\/\/\S+\/agents\/connect\?code=[A-Z0-9]{4}-[A-Z0-9]{4}/.exec(out);
          if (mm && !url) {
            url = mm[0];
            child.kill('SIGINT');
          }
        },
      });
      if (!url.startsWith(`${siteUrl}/agents/connect?code=`))
        problems.push(
          `hivenod pair showed no pairing URL on ${siteUrl} (${p.stderr.trim() || p.stdout.trim()})`,
        );
      else if (!/Pairing cancelled/.test(p.stderr + p.stdout))
        problems.push('hivenod pair did not cancel cleanly');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return problems;
}
