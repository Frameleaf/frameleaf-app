import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { StudioEditorImportService, studioEditorImportStep } from 'src/services/studio-editor-import.service.js';
import { InterchangeCandidate } from 'src/utils/studio-interchange/media.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const fixtures = fileURLToPath(new URL('../../test/fixtures/studio-interchange/', import.meta.url));
const fcpxml = readFileSync(join(fixtures, 'lake-day.fcpxml'));

const operationId = '0195e2a0-0000-7000-8000-000000000012';
const claimToken = '0195e2a0-0000-7000-8000-000000000013';
const uploadId = '0195e2a0-0000-4000-8000-000000000040';
const projectId = '0195e2a0-0000-7000-8000-000000000010';
const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000014' } };
const ids = {
  lake: '0195e2a0-0000-4000-8000-000000000101',
  kayak: '0195e2a0-0000-4000-8000-000000000102',
  sent: '0195e2a0-0000-4000-8000-000000000103',
};
const candidates: InterchangeCandidate[] = [
  { id: ids.lake, name: 'Lake morning.mov', kind: 'video', durationSeconds: 60, width: 3840, height: 2160 },
  { id: ids.kayak, name: 'Kayak.mov', kind: 'video', durationSeconds: 31, width: 1920, height: 1080 },
  { id: ids.sent, name: 'Campfire.wav', kind: 'audio', durationSeconds: 120, width: null, height: null },
];

const upload = {
  id: uploadId,
  ownerId: owner.user.id,
  path: '/data/exports/uploads/lake-day.fcpxml.zip',
  sizeBytes: String(fcpxml.length),
  digest: 'ab'.repeat(32),
  originalFileName: 'Lake day.fcpxml',
  manifest: { kind: 'studio-editor-import' },
  expiresAt: new Date(Date.now() + 3_600_000),
};

const setup = (snapshot: Record<string, unknown>, extra: Partial<MediaOperation> = {}) => {
  const operation = {
    id: operationId,
    ownerId: owner.user.id,
    claimToken,
    kind: MediaOperationKind.StudioEditorImport,
    status: MediaOperationStatus.Rendering,
    progress: 0,
    error: null,
    result: null,
    snapshot,
    ...extra,
  } as unknown as MediaOperation;
  let created = 0;
  const operations = {
    create: vi
      .fn()
      .mockImplementation((value) =>
        Promise.resolve({ ...value, id: `0195e2a0-0000-7000-8000-00000000020${created++}`, status: 'queued' }),
      ),
    getForOwner: vi
      .fn()
      .mockImplementation((id: string, ownerId: string) =>
        Promise.resolve(id === operationId && ownerId === owner.user.id ? operation : undefined),
      ),
    getForWorker: vi.fn().mockResolvedValue(operation),
    heartbeat: vi.fn().mockResolvedValue(true),
    reportProgress: vi.fn().mockResolvedValue(true),
    beginValidation: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue('failed'),
    acknowledgeCancel: vi.fn(),
  };
  const projects = {
    getUpload: vi.fn().mockImplementation((id: string) => Promise.resolve(id === uploadId ? upload : undefined)),
    finalizeUpload: vi.fn().mockImplementation((id: string, value) => Promise.resolve({ ...upload, ...value, id })),
    createWithRevision: vi.fn().mockResolvedValue({ project: { id: projectId }, created: true }),
    getById: vi.fn().mockResolvedValue({ id: projectId, ownerId: owner.user.id, importOperationId: operationId }),
  };
  const repository = {
    getByChecksums: vi.fn().mockResolvedValue(new Map()),
    getCandidates: vi.fn().mockResolvedValue(candidates),
    getUsable: vi
      .fn()
      .mockImplementation((_owner, wanted: string[]) =>
        Promise.resolve(new Set(wanted.filter((id) => candidates.some((item) => item.id === id)))),
      ),
    getUsableFacts: vi
      .fn()
      .mockImplementation((_owner, wanted: string[]) =>
        Promise.resolve(new Map(candidates.filter((item) => wanted.includes(item.id)).map((item) => [item.id, item]))),
      ),
  };
  const bundles = { abortUpload: vi.fn().mockResolvedValue(undefined) };
  const catalog = { getMediaFacts: vi.fn().mockRejectedValue(new Error('not probed')) };
  const assetMedia = { uploadAsset: vi.fn() };
  const albums = { create: vi.fn().mockResolvedValue({ id: 'album' }) };
  const users = { get: vi.fn().mockResolvedValue(owner.user) };
  const storage = {
    readFile: vi.fn(),
    openForRandomRead: vi.fn().mockResolvedValue({
      size: fcpxml.length,
      read: (position: number, length: number) => Promise.resolve(fcpxml.subarray(position, position + length)),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  };
  const logger = { setContext: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const sut = new StudioEditorImportService(
    logger as never,
    operations as never,
    projects as never,
    repository as never,
    bundles as never,
    catalog as never,
    assetMedia as never,
    albums as never,
    users as never,
    storage as never,
  );
  return { sut, operation, operations, projects, repository, bundles, albums };
};

const checkSnapshot = {
  kind: 'studio-editor-import',
  stage: 'check',
  uploadId,
  sidecarUploadIds: [],
  fileName: 'Lake day.fcpxml',
  frameRate: null,
};

describe(StudioEditorImportService.name, () => {
  it('names the step from the progress', () => {
    expect(studioEditorImportStep(MediaOperationStatus.Rendering, 0)).toBe('reading');
    expect(studioEditorImportStep(MediaOperationStatus.Rendering, 30)).toBe('media');
    expect(studioEditorImportStep(MediaOperationStatus.Rendering, 60)).toBe('building');
    expect(studioEditorImportStep(MediaOperationStatus.Rendering, 90)).toBe('checking');
    expect(studioEditorImportStep(MediaOperationStatus.Completed, 100)).toBe('done');
  });

  it('refuses a file that is not a project, CDL or LUT and removes it', async () => {
    const { sut, bundles } = setup(checkSnapshot);
    const file = { path: upload.path, size: 10, originalname: 'notes.pdf' } as Express.Multer.File;
    await expect(sut.registerUpload(owner, file, uploadId)).rejects.toThrow(BadRequestException);
    expect(bundles.abortUpload).toHaveBeenCalledWith(owner, uploadId, true);
  });

  it('queues a check of an uploaded project and refuses one that is not an import upload', async () => {
    const { sut, operations } = setup(checkSnapshot);
    await expect(sut.create(owner, { uploadId })).resolves.toMatchObject({ status: 'queued' });
    expect(operations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: MediaOperationKind.StudioEditorImport,
        snapshot: expect.objectContaining({ stage: 'check' }),
      }),
    );
    await expect(sut.create(owner, { uploadId: '0195e2a0-0000-4000-8000-000000000099' })).rejects.toThrow(
      /no longer here/,
    );
  });

  it('checks the project: timelines, notes, and each file found, to confirm, or missing', async () => {
    const { sut, operations } = setup(checkSnapshot);
    await sut.run({ operation: (await operations.getForWorker()) as MediaOperation, claimToken });
    expect(operations.fail).not.toHaveBeenCalled();
    const { result } = operations.complete.mock.calls[0][2];
    expect(result.source).toBe('finalcut');
    expect(result.timelines).toEqual([expect.objectContaining({ index: 0, name: 'Lake day', durationSeconds: 18 })]);
    expect(result.timelines[0].notes.map((note: { code: string }) => note.code)).toEqual(
      expect.arrayContaining(['effect-dropped']),
    );
    const byName = Object.fromEntries(result.media.map((file: { name: string }) => [file.name, file]));
    expect(byName['Lake morning.mov']).toMatchObject({
      match: 'found',
      assetId: ids.lake,
      assetName: 'Lake morning.mov',
      carried: false,
    });
    expect(byName['Kayak.mp4']).toMatchObject({ match: 'likely', assetId: ids.kayak });
    expect(byName['Ridge.jpg']).toMatchObject({ match: 'missing', assetId: null });
    expect(result.notices).toEqual([expect.objectContaining({ code: 'clips-disabled', subject: '1' })]);
  });

  it('refuses a malformed project without retrying', async () => {
    const { sut, operations } = setup({ ...checkSnapshot, fileName: 'Broken.otio' });
    await sut.run({ operation: (await operations.getForWorker()) as MediaOperation, claimToken });
    expect(operations.fail).toHaveBeenCalledWith(
      operationId,
      claimToken,
      expect.objectContaining({ errorCode: 'studio_editor_import_refused' }),
      { retry: false },
    );
  });

  describe('start', () => {
    const checked = {
      fileName: 'Lake day.fcpxml',
      source: 'finalcut',
      sourceVersion: '1.10',
      notices: [],
      timelines: [
        {
          index: 0,
          name: 'Lake day',
          durationSeconds: 18,
          clips: 4,
          transitions: 1,
          titles: 1,
          sound: 1,
          markers: 1,
          notes: [],
        },
      ],
      media: [
        {
          key: 'lake',
          name: 'Lake morning.mov',
          kind: 'video',
          clips: 1,
          match: 'found',
          confidence: 1,
          assetId: ids.lake,
          assetName: 'Lake morning.mov',
          carried: false,
        },
        {
          key: 'kayak',
          name: 'Kayak.mp4',
          kind: 'video',
          clips: 1,
          match: 'possible',
          confidence: 0.4,
          assetId: ids.kayak,
          assetName: 'Kayak.mov',
          carried: false,
        },
      ],
    };

    it('queues one build per timeline with what the person chose', async () => {
      const { sut, operations } = setup(checkSnapshot, { status: MediaOperationStatus.Completed, result: checked });
      const started = await sut.start(owner, operationId, { timelines: [0], media: [{ key: 'kayak', assetId: null }] });
      expect(started.jobs).toEqual([expect.objectContaining({ timeline: 0, status: 'queued' })]);
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Lake day',
          snapshot: expect.objectContaining({
            stage: 'build',
            timeline: 0,
            media: [
              { key: 'lake', assetId: ids.lake, how: 'found' },
              // A declined match leaves a placeholder.
              { key: 'kayak', assetId: null, how: 'none' },
            ],
          }),
        }),
      );
    });

    it('refuses a timeline that is not in the project and an item that is not usable', async () => {
      const { sut } = setup(checkSnapshot, { status: MediaOperationStatus.Completed, result: checked });
      await expect(sut.start(owner, operationId, { timelines: [3], media: [] })).rejects.toThrow(/Pick timelines/);
      await expect(
        sut.start(owner, operationId, {
          timelines: [0],
          media: [{ key: 'kayak', assetId: '0195e2a0-0000-4000-8000-000000000999' }],
        }),
      ).rejects.toThrow(/not in your library/);
    });

    it('is the owner’s alone', async () => {
      const { sut } = setup(checkSnapshot, { status: MediaOperationStatus.Completed, result: checked });
      await expect(sut.get(authStub.admin, operationId)).rejects.toThrow(NotFoundException);
    });
  });

  it('builds a project idempotently on its job, totals reconciling, sent files in an album', async () => {
    const lakeKey = 'file:///Volumes/Jamie/Rockies/Lake%20morning.mov';
    const kayakKey = 'file:///Volumes/Jamie/Rockies/Kayak.mp4';
    const campfireKey = 'file:///Volumes/Jamie/Music/Campfire.wav';
    const { sut, operations, projects, albums } = setup({
      ...checkSnapshot,
      stage: 'build',
      timeline: 0,
      media: [
        { key: lakeKey, assetId: ids.lake, how: 'found' },
        { key: kayakKey, assetId: ids.kayak, how: 'matched' },
        { key: campfireKey, assetId: ids.sent, how: 'added' },
      ],
    });
    await sut.run({ operation: (await operations.getForWorker()) as MediaOperation, claimToken });
    expect(operations.fail).not.toHaveBeenCalled();
    expect(projects.createWithRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Lake day',
        importOperationId: operationId,
        importedFromDigest: `editor:finalcut:${upload.digest}`,
        revision: expect.objectContaining({ requestKey: `editor-import:${operationId}` }),
      }),
    );
    const { result } = operations.complete.mock.calls[0][2];
    expect(result).toMatchObject({
      projectId,
      timeline: 0,
      media: { found: 1, matched: 1, added: 1, placeholders: 1, total: 4 },
    });
    const { found, matched, added, placeholders, total } = result.media;
    expect(found + matched + added + placeholders).toBe(total);
    expect(albums.create).toHaveBeenCalledWith(expect.anything(), {
      albumName: 'Lake day (from Final Cut Pro)',
      assetIds: [ids.sent],
    });
    const graph = projects.createWithRevision.mock.calls[0][0].revision.envelope.graph;
    expect(JSON.stringify(graph)).toContain(ids.lake);
    expect(JSON.stringify(graph)).not.toContain('/Volumes');
  });

  it('gives the editor a built project’s notes, and nobody else', async () => {
    const built = {
      projectId,
      name: 'Lake day',
      source: 'finalcut',
      fileName: 'Lake day.fcpxml',
      timeline: 0,
      notes: [{ code: 'effect-dropped', clip: 'Kayak.mp4', what: 'Film Glow', became: 'Left out', atSeconds: 6 }],
      notices: [],
      media: { found: 1, matched: 0, added: 0, placeholders: 0, total: 1 },
    };
    const { sut } = setup(
      { ...checkSnapshot, stage: 'build', timeline: 0, media: [] },
      {
        status: MediaOperationStatus.Completed,
        result: built,
      },
    );
    await expect(sut.getProjectNotes(owner, projectId)).resolves.toEqual({
      source: 'finalcut',
      fileName: 'Lake day.fcpxml',
      notes: built.notes,
      notices: [],
    });
    await expect(sut.getProjectNotes(authStub.admin, projectId)).rejects.toThrow(NotFoundException);
  });
});
