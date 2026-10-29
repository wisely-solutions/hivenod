/**
 * The coding CLIs a pairing request may name (cards MkUwvyWs, 3RiuFK00). They were the CLIs the
 * TypeScript `hivenod run <cli>` drove; that client was removed (item MlWOc3O5NyfZcLgetrVo) and the
 * Go CLI pairs as `claude`, but the web app still reads the field of older requests.
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
