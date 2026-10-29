/**
 * Call `read` until it returns a value (not undefined/empty), for up to `timeoutMs`. Throws
 * `message` when it never does. Used by the e2e helpers that look up a user that sign-in has
 * only just created, which can lag under load.
 */
export async function pollFor<T>(
  read: () => Promise<T | undefined | null | ''>,
  message: string,
  timeoutMs = 15_000,
  intervalMs = 250,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() >= end) throw new Error(message);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
