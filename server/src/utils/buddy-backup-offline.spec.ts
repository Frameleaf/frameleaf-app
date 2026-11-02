import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUDDY_OFFLINE_USAGE,
  BuddyOfflineError,
  buddyOfflineFailureMessage,
  runBuddyBackupCommand,
} from 'src/utils/buddy-backup-offline.js';

// FL-509: an owner recovering from machine loss sees the offline command's own safe messages.
describe('frameleaf-admin buddy-backup failure reporting', () => {
  let root: string;
  let exitCode: typeof process.exitCode;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'buddy-offline-'));
    exitCode = process.exitCode;
    process.exitCode = undefined;
    log = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    process.exitCode = exitCode;
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  const printed = () => log.mock.calls.map((call: unknown[]) => String(call[0]));

  it('prints the usage line once for missing arguments', async () => {
    await runBuddyBackupCommand(['recover']);
    expect(printed()).toEqual([BUDDY_OFFLINE_USAGE]);
    expect(process.exitCode).toBe(1);
  });

  it('names an empty or wrong vault path without printing it', async () => {
    const vault = join(root, 'private-name', randomUUID());
    await runBuddyBackupCommand(['recover', '--vault', vault, '--kit', join(root, 'kit.json'), '--output', root]);
    expect(printed()).toEqual(['No complete snapshots in this vault', BUDDY_OFFLINE_USAGE]);
    expect(printed().join('\n')).not.toContain('private-name');
    expect(process.exitCode).toBe(1);
  });

  it('reports an invalid vault identifier and an unknown option', async () => {
    await runBuddyBackupCommand(['export', '--vault', join(root, 'not-a-vault'), '--output', root]);
    await runBuddyBackupCommand(['export', '--bogus']);
    expect(printed()).toEqual([
      'Invalid vault or snapshot identifier',
      BUDDY_OFFLINE_USAGE,
      'Unknown or incomplete option',
      BUDDY_OFFLINE_USAGE,
    ]);
  });

  it('keeps boot-binding failures generic by rethrowing them to the startup handler', async () => {
    await expect(runBuddyBackupCommand(['binding-revoke'])).rejects.toThrow(
      'Invalid replacement-local Buddy boot authority',
    );
    expect(log).not.toHaveBeenCalled();
  });

  it('never prints paths, parser excerpts or library messages', () => {
    const missing = Object.assign(new Error(`ENOENT: no such file or directory, open '${root}/secret-kit.json'`), {
      code: 'ENOENT',
    });
    expect(buddyOfflineFailureMessage(missing)).toBe('A file or directory given to the command does not exist');
    expect(buddyOfflineFailureMessage(new SyntaxError('Unexpected token "k3y-material"'))).toBe(
      'The vault or recovery kit could not be read or verified',
    );
    expect(buddyOfflineFailureMessage(new BuddyOfflineError('Recovery kit exceeds its limit'))).toBe(
      'Recovery kit exceeds its limit',
    );
    expect(buddyOfflineFailureMessage(new Error('Buddy ciphertext failed verification'))).toBe(
      'Buddy ciphertext failed verification',
    );
  });
});
