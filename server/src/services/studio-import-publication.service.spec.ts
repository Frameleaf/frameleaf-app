import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { StudioProjectImport } from 'src/repositories/studio-project.repository.js';
import type { FilePort, JournalPort, PublicationReceipt } from 'src/utils/studio-import-publication.js';
import { StudioImportPublicationService, retainImport } from 'src/services/studio-import-publication.service.js';
import { DECLARATION, KEY, PREPARED } from 'test/fixtures/studio-import-retention.js';

const imported = {
  ...DECLARATION,
  id: KEY.importId,
  ownerId: KEY.ownerId,
  projectId: KEY.projectId,
  path: PREPARED.targetPath,
  createdAt: new Date(0),
} satisfies StudioProjectImport;
const receipt: PublicationReceipt = {
  publicationId: KEY.publicationId,
  importId: KEY.importId,
  state: 'registered',
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(1).toISOString(),
  cleanupPending: false,
};
const ports = () => {
  const files = {
    prepare: vi.fn<FilePort['prepare']>().mockResolvedValue(PREPARED),
    publish: vi.fn<FilePort['publish']>().mockResolvedValue(undefined),
    release: vi.fn<FilePort['release']>().mockResolvedValue(undefined),
  };
  const journal = {
    register: vi.fn<JournalPort['register']>().mockResolvedValue(receipt),
    get: vi.fn<JournalPort['get']>().mockResolvedValue(receipt),
    discover: vi.fn<JournalPort['discover']>(),
    cancel: vi.fn<JournalPort['cancel']>(),
    release: vi.fn<JournalPort['release']>().mockResolvedValue(undefined),
    prepare: vi.fn<JournalPort['prepare']>().mockResolvedValue({ status: 'prepared', file: PREPARED }),
    publish: vi.fn<JournalPort['publish']>().mockResolvedValue(imported),
  };
  return { files, journal };
};
const upload = { key: KEY, incoming: PREPARED.stagedPath, declaration: DECLARATION };

describe('durable publication orchestration with synthetic ports (no SQL/storage qualification)', () => {
  it('never links or removes stage when prepare commit acknowledgement is unknown', async () => {
    const { files, journal } = ports();
    journal.prepare.mockRejectedValue(new Error('commit_unknown'));
    await expect(retainImport(journal, files, upload)).rejects.toThrow('commit_unknown');
    expect(files.publish).not.toHaveBeenCalled();
    expect(files.release).not.toHaveBeenCalled();
    expect(journal.publish).not.toHaveBeenCalled();
    expect(journal.release).not.toHaveBeenCalled();
  });
  it('orders stage barriers, prepare commit, target barriers, final commit and stage cleanup', async () => {
    const events: string[] = [];
    const { files, journal } = ports();
    files.prepare.mockImplementation(() => {
      events.push('stage/file/ancestor-barriers');
      return Promise.resolve(PREPARED);
    });
    journal.prepare.mockImplementation(() => {
      events.push('prepare-commit');
      return Promise.resolve({ status: 'prepared', file: PREPARED });
    });
    files.publish.mockImplementation(() => {
      events.push('link/target-barriers');
      return Promise.resolve();
    });
    journal.publish.mockImplementation(async (_key, publish) => {
      await publish(PREPARED);
      events.push('final-commit');
      return imported;
    });
    files.release.mockImplementation(() => {
      events.push('stage-unlink/barriers');
      return Promise.resolve();
    });
    journal.release.mockImplementation(async (_key, release) => release(PREPARED, 'stage'));
    await expect(retainImport(journal, files, upload)).resolves.toBe(imported);
    expect(events).toEqual([
      'stage/file/ancestor-barriers',
      'prepare-commit',
      'link/target-barriers',
      'final-commit',
      'stage-unlink/barriers',
    ]);
  });
  it.each([
    'target_barrier_failed',
    'commit_unknown',
    'publication_aborted',
    'publication_target_exists',
    'studio_import_repair_required',
    'publication_busy',
  ])('preserves journal ownership when publication refuses: %s', async (message) => {
    const { files, journal } = ports();
    journal.publish.mockRejectedValue(new Error(message));
    await expect(retainImport(journal, files, upload)).rejects.toThrow(message);
    expect(files.release).not.toHaveBeenCalled();
    expect(journal.release).not.toHaveBeenCalled();
  });
  it('does not enter publish for a verified ready retry; cleanup still runs', async () => {
    const { files, journal } = ports();
    journal.prepare.mockResolvedValue({ status: 'ready', imported });
    await expect(retainImport(journal, files, upload)).resolves.toBe(imported);
    expect(journal.publish).not.toHaveBeenCalled();
    expect(files.publish).not.toHaveBeenCalled();
    expect(journal.release).toHaveBeenCalledWith(KEY, expect.any(Function));
  });
  it('returns the committed import when cleanup fails without claiming clean receipt', async () => {
    const { files, journal } = ports();
    journal.release.mockRejectedValue(new Error('cleanup_barrier_failed'));
    journal.get.mockResolvedValue({ ...receipt, state: 'published', cleanupPending: true });
    await expect(retainImport(journal, files, upload)).resolves.toBe(imported);
    await expect(journal.get(KEY)).resolves.toMatchObject({ cleanupPending: true });
  });
});

describe('publication owner facade', () => {
  const setup = () => {
    const { files, journal } = ports();
    const studio = { requireOwnedProject: vi.fn().mockResolvedValue({ id: KEY.projectId, ownerId: KEY.ownerId }) };
    const sut = new StudioImportPublicationService(journal as never, files as never, studio as never);
    const auth = { user: { id: KEY.ownerId } } as AuthDto;
    return { sut, auth, journal, studio };
  };
  it('registers only the current authenticated owner binding', async () => {
    const { sut, auth, journal } = setup();
    await sut.register(auth, KEY.projectId, { importId: KEY.importId, publicationId: KEY.publicationId });
    expect(journal.register).toHaveBeenCalledWith(KEY);
  });
  it('does not read owner or project authority from extra body properties', async () => {
    const { sut, auth, journal } = setup();
    await sut.register(auth, KEY.projectId, {
      importId: KEY.importId,
      publicationId: KEY.publicationId,
      ownerId: KEY.importId,
      projectId: KEY.importId,
    } as never);
    expect(journal.register).toHaveBeenCalledWith(KEY);
  });
  it.each(['getPublication', 'cancel'] as const)(
    'refuses forged owner or project before %s journal calls',
    async (method) => {
      const { sut, auth, journal, studio } = setup();
      await expect(sut[method](auth, { ...KEY, ownerId: KEY.importId })).rejects.toBeInstanceOf(NotFoundException);
      studio.requireOwnedProject.mockResolvedValue({ id: KEY.projectId, ownerId: KEY.importId });
      await expect(sut[method](auth, KEY)).rejects.toBeInstanceOf(NotFoundException);
      expect(journal.get).not.toHaveBeenCalled();
      expect(journal.cancel).not.toHaveBeenCalled();
    },
  );
  it('refuses shared links before discovery', async () => {
    const { sut, auth, journal } = setup();
    await expect(sut.discover({ ...auth, sharedLink: {} } as AuthDto, KEY.projectId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(journal.discover).not.toHaveBeenCalled();
  });
  it('passes an owner-bound discovery cursor and state unchanged to the journal', async () => {
    const { sut, auth, journal } = setup();
    await sut.discover(auth, KEY.projectId, 'cursor', 'published');
    expect(journal.discover).toHaveBeenCalledWith(KEY.ownerId, KEY.projectId, 'cursor', 'published');
  });
});

describe('bounded recovery never publishes or abandons failed cleanup', () => {
  it('continues after a deferred entry and never invokes prepare or publish', async () => {
    const { files, journal } = ports();
    const second = { ...KEY, publicationId: KEY.importId };
    const repository = { ...journal, listRecovery: vi.fn().mockResolvedValue([KEY, second]) };
    repository.release.mockRejectedValueOnce(new Error('cleanup_namespace_barrier_failed'));
    const sut = new StudioImportPublicationService(repository as never, files as never, {} as never);
    await expect(sut.recover()).resolves.toEqual({ attempted: 2, deferred: 1 });
    expect(repository.release).toHaveBeenCalledTimes(2);
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
    expect(files.publish).not.toHaveBeenCalled();
  });
});

describe('exact publication lookup authorizes current owner/project before resolving import binding', () => {
  it.each(['owner', 'stranger', 'shared'] as const)('enforces %s lookup authority', async (kind) => {
    const journal = { getByPublication: vi.fn().mockResolvedValue(receipt) };
    const studio = { requireOwnedProject: vi.fn().mockResolvedValue({ id: KEY.projectId, ownerId: KEY.ownerId }) };
    const sut = new StudioImportPublicationService(journal as never, {} as never, studio as never);
    const actor = {
      user: { id: kind === 'stranger' ? KEY.importId : KEY.ownerId },
      ...(kind === 'shared' && { sharedLink: {} }),
    } as AuthDto;
    if (kind === 'owner') {
      await expect(sut.findPublication(actor, KEY.projectId, KEY.publicationId)).resolves.toBe(receipt);
      expect(journal.getByPublication).toHaveBeenCalledWith(KEY.ownerId, KEY.projectId, KEY.publicationId);
    } else {
      await expect(sut.findPublication(actor, KEY.projectId, KEY.publicationId)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(journal.getByPublication).not.toHaveBeenCalled();
    }
  });
});

describe('test-only commit fault hooks with synthetic ports', () => {
  it.each(['prepare-commit', 'publication-commit'] as const)(
    'does no cleanup after the %s hook stops the writer',
    async (stop) => {
      const { files, journal } = ports();
      const faults = {
        reached: vi.fn((point: string) =>
          point === stop ? Promise.reject(new Error('test_fault')) : Promise.resolve(),
        ),
      };
      await expect(retainImport(journal, files, upload, faults)).rejects.toThrow('test_fault');
      expect(journal.prepare).toHaveResolved();
      expect(journal.release).not.toHaveBeenCalled();
      expect(files.release).not.toHaveBeenCalled();
      if (stop === 'prepare-commit') expect(journal.publish).not.toHaveBeenCalled();
      else expect(journal.publish).toHaveResolved();
    },
  );
  it('does not report a new publication commit for an already ready import', async () => {
    const { files, journal } = ports();
    journal.prepare.mockResolvedValue({ status: 'ready', imported });
    const faults = { reached: vi.fn(() => Promise.resolve()) };
    await retainImport(journal, files, upload, faults);
    expect(faults.reached.mock.calls).toEqual([['prepare-commit']]);
  });
});
