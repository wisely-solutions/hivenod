import { link, mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareAttachment } from './attach';

async function file(name: string, data: string | Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'hive-attach-'));
  const p = join(dir, name);
  await writeFile(p, data);
  return p;
}

describe('prepareAttachment', () => {
  it('detects the type by extension and inlines text', async () => {
    expect(await prepareAttachment(await file('a.html', '<p>x</p>'))).toMatchObject({
      kind: 'html',
      name: 'a.html',
      content: '<p>x</p>',
    });
    expect(await prepareAttachment(await file('a.MD', '# x'))).toMatchObject({ kind: 'markdown' });
    expect(await prepareAttachment(await file('a.txt', 'x'), { name: 'Notes' })).toMatchObject({
      kind: 'text',
      name: 'Notes',
    });
  });

  it('stores images and pdfs as data URLs', async () => {
    const png = await prepareAttachment(await file('a.png', Buffer.from([1, 2, 3])));
    expect(png).toMatchObject({ kind: 'image', content: 'data:image/png;base64,AQID' });
    expect((await prepareAttachment(await file('a.jpeg', 'x'))).content).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    expect((await prepareAttachment(await file('a.pdf', 'x'))).kind).toBe('pdf');
  });

  it('accepts a URL as a link', async () => {
    expect(await prepareAttachment('https://example.com/docs/report.pdf')).toEqual({
      kind: 'link',
      name: 'report.pdf',
      url: 'https://example.com/docs/report.pdf',
    });
  });

  it('accepts exactly 900 KB and rejects more, with a hint', async () => {
    const ok = await prepareAttachment(await file('ok.txt', 'x'.repeat(900 * 1024)));
    expect(ok.content).toHaveLength(900 * 1024);
    await expect(
      prepareAttachment(await file('big.txt', 'x'.repeat(900 * 1024 + 1))),
    ).rejects.toThrow(/big\.txt is 901 KB, over the 900 KB limit.*attach its URL/s);
  });

  it('counts the base64 size of images', async () => {
    await expect(
      prepareAttachment(await file('big.png', Buffer.alloc(800 * 1024))),
    ).rejects.toThrow(/once encoded/);
  });

  it('rejects unknown types and missing files', async () => {
    await expect(prepareAttachment(await file('a.zip', 'x'))).rejects.toThrow(
      /use html, md, txt, png, jpg or pdf/,
    );
    await expect(prepareAttachment('/nope/missing.html')).rejects.toThrow(/File not found/);
  });
});

describe('prepareAttachment never reads protected folders (tester R80)', () => {
  // A fake ~/.hivenod with a token file, and a work folder that tries to reach it.
  async function setup() {
    const root = await mkdtemp(join(tmpdir(), 'hive-guard-'));
    const home = join(root, 'home');
    const work = join(root, 'work');
    const run = join(root, 'run');
    await mkdir(home, { mode: 0o700 });
    await mkdir(work);
    await mkdir(run);
    await writeFile(join(home, 'agent.json'), '{"token":"secret"}');
    await writeFile(join(home, 'notes.txt'), 'secret');
    await writeFile(join(run, 'x.txt'), 'private');
    await writeFile(join(work, 'ok.txt'), 'fine');
    const before = process.env.HIVENOD_HOME;
    process.env.HIVENOD_HOME = home;
    return { root, home, work, run, restore: () => (process.env.HIVENOD_HOME = before) };
  }
  const refused = /credentials folder/;

  it('refuses the credentials folder itself, absolute and relative', async () => {
    const s = await setup();
    try {
      await expect(prepareAttachment(join(s.home, 'notes.txt'))).rejects.toThrow(refused);
      await expect(
        prepareAttachment(relative(process.cwd(), join(s.home, 'notes.txt'))),
      ).rejects.toThrow(refused);
    } finally {
      s.restore();
    }
  });

  it('refuses a symlink to a file in the credentials folder', async () => {
    const s = await setup();
    try {
      await symlink(join(s.home, 'notes.txt'), join(s.work, 'decoy.txt'));
      await expect(prepareAttachment(join(s.work, 'decoy.txt'))).rejects.toThrow(refused);
    } finally {
      s.restore();
    }
  });

  it('refuses a relative symlink, and a chain of symlinks', async () => {
    const s = await setup();
    try {
      await symlink('../home/notes.txt', join(s.work, 'rel.txt'));
      await symlink('rel.txt', join(s.work, 'chain.txt'));
      await expect(prepareAttachment(join(s.work, 'rel.txt'))).rejects.toThrow(refused);
      await expect(prepareAttachment(join(s.work, 'chain.txt'))).rejects.toThrow(refused);
    } finally {
      s.restore();
    }
  });

  it('refuses a symlinked folder and a symlinked parent folder', async () => {
    const s = await setup();
    try {
      await symlink(s.home, join(s.work, 'cfg'));
      await expect(prepareAttachment(join(s.work, 'cfg', 'notes.txt'))).rejects.toThrow(refused);
      await mkdir(join(s.work, 'deep'));
      await symlink('../cfg', join(s.work, 'deep', 'up'));
      await expect(prepareAttachment(join(s.work, 'deep', 'up', 'notes.txt'))).rejects.toThrow(
        refused,
      );
    } finally {
      s.restore();
    }
  });

  it('refuses a hard link to a file in the credentials folder', async () => {
    const s = await setup();
    try {
      await link(join(s.home, 'notes.txt'), join(s.work, 'hard.txt'));
      await expect(prepareAttachment(join(s.work, 'hard.txt'))).rejects.toThrow(refused);
    } finally {
      s.restore();
    }
  });

  it('refuses extra protected folders (the run folder), also through links, with its own wording', async () => {
    const s = await setup();
    const runFolder = /run folder/;
    try {
      await symlink(join(s.run, 'x.txt'), join(s.work, 'r.txt'));
      await expect(prepareAttachment(join(s.run, 'x.txt'), { deny: [s.run] })).rejects.toThrow(
        runFolder,
      );
      await expect(prepareAttachment(join(s.work, 'r.txt'), { deny: [s.run] })).rejects.toThrow(
        runFolder,
      );
      // Not the credentials wording (card JJ6fYb3b): that folder is a different thing.
      await expect(prepareAttachment(join(s.run, 'x.txt'), { deny: [s.run] })).rejects.not.toThrow(
        refused,
      );
      // A hard link into the run folder says the same, and the credentials folder keeps its own.
      await link(join(s.run, 'x.txt'), join(s.work, 'hard-run.txt'));
      await expect(
        prepareAttachment(join(s.work, 'hard-run.txt'), { deny: [s.run] }),
      ).rejects.toThrow(runFolder);
      await expect(prepareAttachment(join(s.home, 'notes.txt'), { deny: [s.run] })).rejects.toThrow(
        refused,
      );
    } finally {
      s.restore();
    }
  });

  it('refuses things that are not regular files', async () => {
    const s = await setup();
    try {
      await mkdir(join(s.work, 'dir.txt'));
      await expect(prepareAttachment(join(s.work, 'dir.txt'))).rejects.toThrow(/not a file/);
    } finally {
      s.restore();
    }
  });

  it('still attaches ordinary files and symlinks inside the work folder', async () => {
    const s = await setup();
    try {
      await symlink('ok.txt', join(s.work, 'alias.txt'));
      expect((await prepareAttachment(join(s.work, 'ok.txt'))).content).toBe('fine');
      expect(await prepareAttachment(join(s.work, 'alias.txt'))).toMatchObject({
        name: 'alias.txt',
        content: 'fine',
      });
    } finally {
      s.restore();
    }
  });
});
