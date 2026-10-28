/**
 * Reading a file someone (often a model) named, without ever reading Hivenod's own private folders:
 * the credentials folder (~/.hivenod, HIVENOD_HOME) and, during `hivenod run`, the run's bridge folder.
 *
 * A plain path check is not enough (tester R80): a symlink in the work folder, a symlinked parent
 * folder, a relative link or a hard link can all point into ~/.hivenod. So the guard:
 *  1. checks the path as written and its realpath (all symlinks resolved, parents included);
 *  2. opens the file (O_NOFOLLOW on the resolved path, O_NONBLOCK so a FIFO cannot hang us);
 *  3. checks the opened file: a regular file, the same inode the realpath named (so a swap between
 *     check and open is caught), on Linux the fd's own path, and that its inode is not any file in
 *     a protected folder (hard links have no path of their own to check).
 * The caller then reads from that open file, never from the path again.
 */
import { constants, lstatSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hiveHome, legacyHome } from './credentials';
import { HiveError } from './errors';

export const PROTECTED_MESSAGE = 'Files in the Hivenod credentials folder cannot be attached.';
export const RUN_FOLDER_MESSAGE =
  "Files in hivenod run's private run folder (its temporary working folder) cannot be attached.";

/** The refusal for a file in this protected folder: the credentials folder or a run's own. */
function messageFor(dir: string): string {
  const forms = new Set([hiveHome(), legacyHome()].flatMap((h) => [resolve(h), real(h)]));
  return forms.has(resolve(dir)) || forms.has(real(dir)) ? PROTECTED_MESSAGE : RUN_FOLDER_MESSAGE;
}

/** The folders no attachment may come from: the credentials folder plus any extra ones. */
export function protectedDirs(extra: readonly string[] = []): string[] {
  return [hiveHome(), legacyHome(), ...extra];
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

function inside(dir: string, p: string): boolean {
  const rel = relative(dir, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The protected folder `p` (already absolute) is in, as written or once resolved; else null. */
function protectedDirOf(p: string, dirs: readonly string[]): string | null {
  return (
    dirs.find((d) => {
      const forms = new Set([resolve(d), real(d)]);
      return [...forms].some((f) => inside(f, p));
    }) ?? null
  );
}

/**
 * Throws when the path, as written or with every symlink resolved, is in a protected folder.
 * Cheap check for early, clear errors; `openGuarded` repeats it on the opened file.
 */
export function assertNotProtected(path: string, extra: readonly string[] = []): void {
  const dirs = protectedDirs(extra);
  const abs = resolve(path);
  const hit = protectedDirOf(abs, dirs) ?? protectedDirOf(real(abs), dirs);
  if (hit) throw new HiveError(messageFor(hit));
}

/** dev:ino of every file in the protected folders (a few levels deep), with its folder. */
function protectedInodes(dirs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let budget = 2000;
  const walk = (dir: string, depth: number, top: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (--budget < 0) return;
      const p = join(dir, n);
      try {
        const st = lstatSync(p, { bigint: true });
        if (st.isFile()) out.set(`${st.dev}:${st.ino}`, top);
        else if (st.isDirectory() && depth < 4) walk(p, depth + 1, top);
      } catch {
        // gone meanwhile
      }
    }
  };
  for (const d of dirs) walk(real(d), 0, d);
  return out;
}

/**
 * Opens `path` for reading after the checks above. Throws HiveError for protected files,
 * missing files and anything that is not a regular file. The caller must close the handle.
 */
export async function openGuarded(
  path: string,
  extra: readonly string[] = [],
): Promise<FileHandle> {
  assertNotProtected(path, extra);
  const dirs = protectedDirs(extra);
  let target: string;
  try {
    target = realpathSync.native(resolve(path));
  } catch {
    throw new HiveError(`File not found: ${path}`);
  }
  let fh: FileHandle;
  try {
    fh = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    throw new HiveError(`File not found: ${path}`);
  }
  try {
    const st = await fh.stat({ bigint: true });
    if (!st.isFile()) throw new HiveError(`Cannot attach "${path}": it is not a file.`);
    let now: { dev: bigint; ino: bigint };
    try {
      now = lstatSync(target, { bigint: true });
    } catch {
      throw new HiveError(`File not found: ${path}`);
    }
    // The path changed between the check and the open (e.g. swapped for a link): refuse.
    if (now.dev !== st.dev || now.ino !== st.ino)
      throw new HiveError(`Cannot attach "${path}": it changed while it was being read.`);
    if (process.platform === 'linux') {
      let fdPath: string | null = null;
      try {
        fdPath = readlinkSync(`/proc/self/fd/${fh.fd}`);
      } catch {
        fdPath = null;
      }
      const hit = fdPath ? protectedDirOf(fdPath, dirs) : null;
      if (hit) throw new HiveError(messageFor(hit));
    }
    const linked = protectedInodes(dirs).get(`${st.dev}:${st.ino}`);
    if (linked) throw new HiveError(messageFor(linked));
    return fh;
  } catch (e) {
    await fh.close();
    throw e;
  }
}
