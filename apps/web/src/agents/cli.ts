/**
 * The commands the agent setup shows. The Hivenod CLI is one native binary (item
 * zLwtX2WEEg3mER4CR74g) served from Hivenod's own hosting with a SHA-256 checksum next to it
 * (scripts/build-cli-bin.mjs, run by `pnpm release`); install.sh / install.ps1 check it. No Node.
 */

export const CLAUDE_INSTALL_DOCS = 'https://docs.claude.com/en/docs/claude-code/setup';
export const CLAUDE_PERMISSIONS_DOCS = 'https://docs.claude.com/en/docs/claude-code/iam';

export function cliCommands(origin: string) {
  const o = origin.replace(/\/+$/, '');
  return {
    install: `curl -fsSL ${o}/install.sh | sh`,
    installWindows: `irm ${o}/install.ps1 | iex`,
    check: 'hivenod --version',
  };
}

/**
 * The only way to connect an agent for now (cards KLCTVnX8, Ul32d6Ee): pair the machine once,
 * then the hivenod plugin from the marketplace in the Hivenod repository, as a live Claude Code
 * session. Until Hivenod is on Claude Code's approved channels list, the session starts with the
 * development-channels flag. `hivenod run` is paused.
 */
export const SESSION_COMMANDS = {
  pair: 'hivenod pair',
  marketplace: 'claude plugin marketplace add wisely-solutions/hivenod',
  plugin: 'claude plugin install hivenod@hivenod',
  start: 'claude --dangerously-load-development-channels plugin:hivenod@hivenod',
  /** For people who already run other channel sessions: a Claude config of its own. */
  separateConfig: 'export CLAUDE_CONFIG_DIR=~/.claude-hivenod',
} as const;

export const TROUBLESHOOTING: readonly { problem: string; fix: string }[] = [
  {
    problem: 'hivenod: command not found',
    fix: 'The installer puts hivenod in ~/.local/bin (on Windows in %LOCALAPPDATA%\\hivenod). Add that folder to your PATH and open a new terminal.',
  },
  {
    problem: 'The folder is not trusted',
    fix: 'Run claude once in the work folder and accept the trust prompt, then start the session again.',
  },
  {
    problem: 'The install stops with a checksum mismatch',
    fix: 'The download was cut off or changed on the way, so nothing was installed. Run the install command again.',
  },
  {
    problem: 'The code expired or was not found',
    fix: 'Run hivenod pair again for a new code (a code is valid for 15 minutes).',
  },
];
