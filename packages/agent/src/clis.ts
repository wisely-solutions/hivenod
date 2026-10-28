/** The adapters `hivenod run <cli>` knows (card 3RiuFK00). */
import type { RunCli } from '@hive/shared';
import { claudeAdapter, type CliAdapter } from './adapter';
import { codexAdapter } from './codex';
import { copilotAdapter } from './copilot';

export const ADAPTERS: Record<RunCli, CliAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  copilot: copilotAdapter,
};
