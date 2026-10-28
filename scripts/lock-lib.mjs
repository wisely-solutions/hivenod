/** Is the process alive? `kill` is injectable for tests (process.kill signature). */
export function isAlive(pid, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
