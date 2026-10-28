/**
 * The coding CLIs `hivenod run <cli>` can drive (cards MkUwvyWs, 3RiuFK00). Claude Code is verified;
 * Codex and GitHub Copilot CLI are experimental: built from their docs, help output and package
 * source, never run against a real account (see packages/agent/README.md, "Verified or not").
 */
export const RUN_CLIS = ['claude', 'codex', 'copilot'] as const;
export type RunCli = (typeof RUN_CLIS)[number];

export const CLI_INFO: Record<RunCli, { name: string; experimental: boolean }> = {
  claude: { name: 'Claude Code', experimental: false },
  codex: { name: 'Codex', experimental: true },
  copilot: { name: 'GitHub Copilot CLI', experimental: true },
};

export const isRunCli = (cli: string): cli is RunCli =>
  (RUN_CLIS as readonly string[]).includes(cli);

/** "Claude Code", "Codex (experimental, untested)", or the raw name for anything else. */
export function cliLabel(cli: string): string {
  if (!isRunCli(cli)) return cli;
  const info = CLI_INFO[cli];
  return info.experimental ? `${info.name} (experimental, untested)` : info.name;
}
