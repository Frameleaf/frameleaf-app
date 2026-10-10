import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractVerifiedContractsArchive } from './verified-contracts-archive.mjs';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

const actualChildProcess = await vi.importActual('node:child_process');
const receipt = JSON.parse(readFileSync(new URL('./contracts-package-receipt.json', import.meta.url), 'utf8'));

describe('immutable package extraction', () => {
  let folder;
  let archivePath;
  beforeEach(() => {
    const supplied = process.env.FRAMELEAF_CLOUD_LIFECYCLE_TGZ;
    if (!supplied) throw new Error('Required immutable registry archive is unavailable for extraction controls');
    folder = mkdtempSync(join(tmpdir(), 'library-lifecycle-archive-control-'));
    archivePath = join(folder, 'package.tgz');
    writeFileSync(archivePath, readFileSync(supplied));
  });
  afterEach(() => {
    vi.clearAllMocks();
    if (folder) rmSync(folder, { recursive: true, force: true });
  });

  it('extracts the verified bytes even if the source path is replaced before tar starts', () => {
    spawnSync.mockImplementationOnce((command, args, options) => {
      // Mutate only our temporary copy at the verify/extract boundary; run the real tar.
      writeFileSync(archivePath, Buffer.from('replaced archive'));
      return actualChildProcess.spawnSync(command, args, options);
    });
    expect(() => extractVerifiedContractsArchive(archivePath, receipt, folder)).not.toThrow();
    const manifest = JSON.parse(readFileSync(join(folder, 'package/package.json'), 'utf8'));
    expect(manifest.name).toBe('@frameleaf/cloud-contracts');
    expect(manifest.version).toBe('0.0.5');
  });

  it('rejects a same-length byte mutation before invoking tar', () => {
    const bytes = readFileSync(archivePath);
    bytes[0] ^= 1;
    writeFileSync(archivePath, bytes);
    expect(() => extractVerifiedContractsArchive(archivePath, receipt, folder)).toThrow(
      'Cloud contracts archive does not match the pinned receipt',
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('requires SHA-512 integrity even when length and SHA-256 match', () => {
    expect(() =>
      extractVerifiedContractsArchive(archivePath, { ...receipt, integrity: 'sha512-invalid' }, folder),
    ).toThrow('Cloud contracts archive does not match the pinned receipt');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
