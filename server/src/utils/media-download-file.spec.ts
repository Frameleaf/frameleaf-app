import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyMediaDownload } from 'src/utils/media-download-file.js';

describe(copyMediaDownload.name, () => {
  let root: string;
  let source: string;
  let destination: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'media-file-test-'));
    source = join(root, 'input');
    destination = join(root, 'output');
    await mkdir(source);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copies the validated local file and returns its SHA-256', async () => {
    const file = join(source, 'media.mp4');
    await writeFile(file, 'abc');
    const result = await copyMediaDownload(file, destination, 3);
    expect(result).toEqual({ size: 3, sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    expect(await readFile(destination, 'utf8')).toBe('abc');
  });

  it('rejects a symlink outside the worker staging directory', async () => {
    const target = join(root, 'outside');
    await writeFile(target, 'fixture');
    const file = join(source, 'media.mp4');
    await symlink(target, file);
    await expect(copyMediaDownload(file, destination, 20)).rejects.toThrow();
    await expect(readFile(destination)).rejects.toThrow();
  });

  it('rejects a file exceeding the byte limit before writing the destination', async () => {
    const file = join(source, 'media.mp4');
    await writeFile(file, 'abc');
    await expect(copyMediaDownload(file, destination, 2)).rejects.toMatchObject({ code: 'too_large' });
    await expect(readFile(destination)).rejects.toThrow();
  });
});
