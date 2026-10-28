/** Resend cooldown for the "Check your email" screen. Firebase rate-limits verification mails, so
 *  the clock starts when a mail goes out (sign-up included), not when the user first presses Resend. */
export const SEND_COOLDOWN_S = import.meta.env.VITE_USE_EMULATOR === '1' ? 3 : 30;
export const REFUSED_COOLDOWN_S = import.meta.env.VITE_USE_EMULATOR === '1' ? 4 : 60;

let until = 0; // ms timestamp when Resend may be pressed again
let owner = ''; // the email the clock belongs to

export function startCooldown(email: string, seconds: number, now = Date.now()): void {
  owner = email.trim().toLowerCase();
  until = now + seconds * 1000;
}

export function cooldownLeft(email: string, now = Date.now()): number {
  if (email.trim().toLowerCase() !== owner) return 0;
  return Math.max(0, Math.ceil((until - now) / 1000));
}

export function resetCooldown(): void {
  owner = '';
  until = 0;
}

/** Firebase's rate-limit answer (as opposed to a network or other failure). */
export function isTooManyRequests(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'auth/too-many-requests';
}
