import request from 'supertest';
import { NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StudioProjectImportController } from 'src/controllers/studio-project-import.controller.js';
import { StudioProjectImportService } from 'src/services/studio-project-import.service.js';
import { StudioImportPublicationService } from 'src/services/studio-import-publication.service.js';
import { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { controllerSetup, type ControllerContext } from 'test/utils.js';
import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';

const base = `/studio/projects/${KEY.projectId}/imports`;
const receipt = {
  publicationId: KEY.publicationId,
  importId: KEY.importId,
  state: 'published',
  createdAt: '2026-10-11T00:00:00Z',
  expiresAt: '2026-10-11T06:00:00Z',
  cleanupPending: true,
  imported: {
    id: KEY.importId,
    kind: 'video',
    contentType: 'video/mp4',
    checksum: 'ab'.repeat(32),
    sizeBytes: 4,
    fileName: 'out.mp4',
    externalReferences: null,
    createdAt: '2026-10-11T00:00:00Z',
    processingProvenance: { ...LINEAGE, outputSha256: 'ab'.repeat(32) },
    path: '/private/never-public',
    ownerId: KEY.ownerId,
  },
  stagedPath: '/private/stage',
};

describe('canonical publication HTTP contract (controlled repository)', () => {
  let ctx: ControllerContext;
  const journal = { register: vi.fn(), getByPublication: vi.fn(), discover: vi.fn(), cancel: vi.fn() };
  const studio = {
    requireOwnedProject: vi.fn(async (auth: AuthDto, id: string) => {
      if (auth.user.id !== KEY.ownerId || id !== KEY.projectId) throw new NotFoundException('Studio project not found');
      return { id: KEY.projectId, ownerId: KEY.ownerId };
    }),
  };
  beforeAll(async () => {
    const facade = new StudioImportPublicationService(journal as never, {} as never, studio as never);
    const service = new StudioProjectImportService(
      { setContext: vi.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      studio as never,
      facade,
    );
    ctx = await controllerSetup(StudioProjectImportController, [
      { provide: StudioProjectImportService, useValue: service },
      { provide: StudioBundleService, useValue: {} },
      {
        provide: LoggingRepository,
        useValue: { setContext: vi.fn(), error: vi.fn(), warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
      },
    ]);
    return () => ctx.close();
  });
  beforeEach(() => {
    ctx.reset();
    ctx.authenticate.mockResolvedValue({ user: { id: KEY.ownerId } });
    for (const fn of Object.values(journal)) fn.mockReset();
    journal.register.mockResolvedValue(receipt);
    journal.getByPublication.mockResolvedValue(receipt);
    journal.discover.mockResolvedValue({ items: [receipt], nextCursor: null });
    journal.cancel.mockResolvedValue({ status: 'already-published', receipt });
  });
  const operations = () => [
    () =>
      request(ctx.getHttpServer())
        .post(`${base}/publications`)
        .send({ publicationId: KEY.publicationId, importId: KEY.importId }),
    () => request(ctx.getHttpServer()).get(`${base}/publications`),
    () => request(ctx.getHttpServer()).get(`${base}/publications/${KEY.publicationId}`),
    () => request(ctx.getHttpServer()).post(`${base}/${KEY.importId}/publications/${KEY.publicationId}/cancel`),
  ];
  it('exposes all four authenticated routes with only canonical public receipt/import fields', async () => {
    for (const invoke of operations()) {
      const response = await invoke();
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
      expect(JSON.stringify(response.body)).not.toContain('/private');
      expect(JSON.stringify(response.body)).not.toContain('ownerId');
      const value = response.body.receipt ?? response.body.items?.[0] ?? response.body;
      expect(value.imported.processingProvenance.outputSha256).toBe('ab'.repeat(32));
      expect(value.cleanupPending).toBe(true);
    }
    expect(ctx.authenticate).toHaveBeenCalledTimes(4);
  });
  it.each(['stranger', 'shared'] as const)(
    'refuses %s authority on every operation before journal access',
    async (kind) => {
      ctx.authenticate.mockResolvedValue(
        kind === 'shared' ? { user: { id: KEY.ownerId }, sharedLink: {} } : { user: { id: KEY.importId } },
      );
      for (const invoke of operations()) expect((await invoke()).status).toBe(404);
      for (const fn of Object.values(journal)) expect(fn).not.toHaveBeenCalled();
    },
  );
  it('rejects unknown registration/query fields, malformed IDs, states and cursors', async () => {
    for (const body of [
      { publicationId: KEY.publicationId, importId: KEY.importId, ownerId: KEY.ownerId },
      { publicationId: 'bad', importId: KEY.importId },
    ])
      expect((await request(ctx.getHttpServer()).post(`${base}/publications`).send(body)).status).toBe(400);
    for (const query of [
      { state: 'bad' },
      { cursor: '' },
      { cursor: 'not+opaque' },
      { limit: '101' },
      { cursor: ['a', 'b'] },
    ])
      expect((await request(ctx.getHttpServer()).get(`${base}/publications`).query(query)).status).toBe(400);
    expect(
      (await request(ctx.getHttpServer()).get(`/studio/projects/${KEY.importId}/imports/publications`)).status,
    ).toBe(400);
    expect((await request(ctx.getHttpServer()).get(`${base}/publications/bad`)).status).toBe(400);
    for (const fn of Object.values(journal)) expect(fn).not.toHaveBeenCalled();
  });
  it('forwards explicit opaque continuation/state without implicit polling or truncation', async () => {
    journal.discover
      .mockResolvedValueOnce({ items: Array.from({ length: 100 }, () => receipt), nextCursor: 'Y3Vyc29y' })
      .mockResolvedValueOnce({ items: [receipt], nextCursor: null });
    const one = await request(ctx.getHttpServer()).get(`${base}/publications`).query({ state: 'published' });
    expect(one.body.items).toHaveLength(100);
    expect(one.body.nextCursor).toBe('Y3Vyc29y');
    const two = await request(ctx.getHttpServer())
      .get(`${base}/publications`)
      .query({ state: 'published', cursor: one.body.nextCursor });
    expect(two.body.items).toHaveLength(1);
    expect(two.body.nextCursor).toBeNull();
    expect(journal.discover).toHaveBeenLastCalledWith(KEY.ownerId, KEY.projectId, 'Y3Vyc29y', 'published');
  });
  it('answers absent exact receipt with 404', async () => {
    journal.getByPublication.mockResolvedValue(null);
    expect((await request(ctx.getHttpServer()).get(`${base}/publications/${KEY.publicationId}`)).status).toBe(404);
  });
});
