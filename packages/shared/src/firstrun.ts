import { z } from 'zod';

/**
 * First-run checklist progress of one person in one organization (card tIG1wr4Z).
 * The steps are remembered once seen done ("ever had"), so closing the last idea or
 * revoking the agent never brings the checklist back; `dismissed` follows the person across devices.
 */
export const firstRunSchema = z.object({
  dismissed: z.boolean(),
  project: z.boolean(),
  idea: z.boolean(),
  agent: z.boolean(),
});
export type FirstRunDoc = z.infer<typeof firstRunSchema>;

export const firstRunPath = (uid: string, wid: string) => `users/${uid}/firstrun/${wid}`;
