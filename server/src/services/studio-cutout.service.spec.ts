import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { CutoutUnavailableError, CutoutWorkerError } from 'src/repositories/machine-learning.repository.js';
import { StudioCutoutService, composeAtlas } from 'src/services/studio-cutout.service.js';
import { getConfig } from 'src/utils/config.js';
import { homeMlDestinationId, selectMlDestination } from 'src/utils/ml-destination.js';
import { rational } from 'src/utils/rational-time.js';
import {
  CUTOUT_ATLAS_MAX_WIDTH,
  CUTOUT_MAX_FRAMES,
  atlasCell,
  cutoutDeadlineMs,
  cutoutPlan,
  faceFraction,
  matchFirstFrameFace,
  workerPoints,
} from 'src/utils/studio-cutout.js';
import { StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const someoneElse = {
  user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000097' },
} as typeof authStub.user1;

vi.mock('src/utils/ml-destination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/ml-destination.js')>()),
  selectMlDestination: vi.fn(),
  homeMlDestinationId: vi.fn(),
}));
vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn(),
}));
vi.mock('src/utils/studio-cutout.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('src/utils/studio-cutout.js')>();
  return { ...actual, cutoutDeadlineMs: vi.fn(actual.cutoutDeadlineMs) };
});
vi.mock('src/services/studio-project-import.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/services/studio-project-import.service.js')>()),
  studioImportIncomingFolder: () => incomingFolder,
}));

let incomingFolder = '';

const projectId = '0195e2a0-0000-7000-8000-000000000030';
const assetId = '0195e2a0-0000-7000-8000-000000000031';
const destinationId = '0195e2a0-0000-4000-8000-000000000032';
const jamie = '0195e2a0-0000-4000-8000-000000000033';
const sam = '0195e2a0-0000-4000-8000-000000000034';
const graph = {
  metadata: { fps: 30 },
  timeline: {
    items: [
      // Two seconds of the source from 3 s on.
      { id: 'clip', type: 'video', mediaId: assetId, from: 60, durationInFrames: 60, sourceStart: 90, sourceFps: 30 },
      { id: 'song', type: 'audio', mediaId: assetId, from: 0, durationInFrames: 60, sourceStart: 0, sourceFps: 30 },
    ],
  },
};

const face = (personId: string | null, name: string, x1: number, x2: number, isHidden = false) => ({
  id: `face-${personId ?? 'unnamed'}-${x1}`,
  boundingBoxX1: x1,
  boundingBoxX2: x2,
  boundingBoxY1: 100,
  boundingBoxY2: 300,
  imageWidth: 1000,
  imageHeight: 1000,
  person: personId ? { id: personId, name, isHidden } : null,
});

const grayPng = (width: number, height: number, value: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: value, g: value, b: value } } })
    .toColourspace('b-w')
    .png()
    .toBuffer();

/** Faces found on a 640x360 first frame, with embeddings: Sam's twin on the left, Jamie on the right. */
const firstFrame = {
  imageWidth: 640,
  imageHeight: 360,
  faces: [
    { boundingBox: { x1: 64, y1: 36, x2: 128, y2: 108 }, embedding: '[0, 1, 0]', score: 0.9 },
    { boundingBox: { x1: 448, y1: 72, x2: 512, y2: 144 }, embedding: '[0.9, 0.1, 0]', score: 0.9 },
  ],
};

const setup = ({
  faceDetection = true,
  detected = firstFrame,
  kind = MlDestinationKind.Local,
  faces = [face(jamie, 'Jamie', 400, 600), face(sam, 'Sam', 100, 150), face(null, '', 700, 900)],
  matte = async (...args: any[]) => {
    const [, framePaths, options, , onFrame, onProgress] = args;
    for (const [index] of framePaths.entries()) {
      await onFrame(index, await grayPng(options.matteWidth, options.matteHeight, index === 0 ? 255 : 128));
      onProgress(index + 1, framePaths.length);
    }
  },
} = {}) => {
  const studio = {
    requireOwnedProject: vi.fn().mockResolvedValue({}),
    authorizeRevision: vi.fn().mockResolvedValue({
      project: { archivedAt: null },
      revision: { revision: 3 },
      envelope: { graph },
    }),
  };
  const resources = {
    resolveProjectResources: vi.fn().mockResolvedValue({
      manifest: {
        entries: [
          {
            key: `library-asset:${assetId}`,
            kind: StudioResourceKind.LibraryAsset,
            id: assetId,
            assetId,
            path: '/library/clip.mov',
            grant: 'render',
          },
        ],
      },
    }),
  };
  const projects = {
    listImportDeclarations: vi.fn().mockResolvedValue([]),
    listGeneratedResources: vi.fn().mockResolvedValue([]),
  };
  const persons = {
    getFaces: vi.fn().mockResolvedValue(faces),
    getFaceForFacialRecognitionJob: vi.fn().mockResolvedValue({ faceSearch: { embedding: '[1, 0, 0]' } }),
  };
  const media = {
    probe: vi.fn().mockResolvedValue({ videoStreams: [{ width: 1920, height: 1080, rotation: 0 }], audioStreams: [] }),
  };
  const clips = {
    extractFrames: vi.fn().mockImplementation(async (_input: string, folder: string, _window, options) => {
      for (let index = 1; index <= Math.min(options.frames, 3); index++) {
        await writeFile(path.join(folder, `${String(index).padStart(5, '0')}.jpg`), 'jpeg');
      }
    }),
  };
  const machineLearning = {
    subjectMatte: vi.fn().mockImplementation(matte),
    detectFaces: vi.fn().mockResolvedValue(detected),
  };
  const mlDestinations = { getById: vi.fn().mockResolvedValue({ id: destinationId, kind }) };
  const uploads: Array<{ id: string; png: Buffer; name: string }> = [];
  const imports = {
    upload: vi.fn().mockImplementation(async (_auth, _project, id: string, file: Express.Multer.File) => {
      uploads.push({ id, png: await readFile(file.path), name: file.originalname });
      return { id };
    }),
  };
  vi.mocked(homeMlDestinationId).mockResolvedValue(destinationId);
  vi.mocked(selectMlDestination).mockResolvedValue({ destinationId, kind, workload: MlWorkload.StudioAi } as never);
  vi.mocked(getConfig).mockResolvedValue({
    machineLearning: {
      enabled: true,
      urls: ['http://ml:3003'],
      facialRecognition: { enabled: faceDetection, modelName: 'buffalo_l', minScore: 0.7 },
    },
  } as never);
  const logger = { setContext: vi.fn(), warn: vi.fn(), debug: vi.fn() };
  const sut = new StudioCutoutService(
    logger as never,
    studio as never,
    resources as never,
    projects as never,
    persons as never,
    media as never,
    clips as never,
    machineLearning as never,
    mlDestinations as never,
    imports as never,
    {} as never,
    {} as never,
  );
  return { sut, studio, resources, persons, clips, machineLearning, imports, uploads };
};

/** Wait for the job the service runs in the background to settle. */
const settled = async (sut: StudioCutoutService, id: string) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const job = sut.get(authStub.user1, projectId, id);
    if (job.status === 'completed' || job.status === 'failed') {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The cut-out never settled');
};

describe('studio cut-out plan', () => {
  const clip = (seconds: number) => ({
    durationInFrames: seconds * 30,
    cadence: rational(30),
    speed: rational(1),
    sourceStart: rational(3),
  });

  it('reads a short clip ten times a second at the matte and frame sizes', () => {
    expect(cutoutPlan(clip(2), { width: 1920, height: 1080 })).toEqual({
      startSeconds: 3,
      durationSeconds: 2,
      fps: 10,
      frames: 20,
      frameWidth: 640,
      frameHeight: 360,
      matteWidth: 192,
      matteHeight: 108,
      columns: 20,
      rows: 1,
    });
  });

  it('reads a long clip less often, keeps the atlas narrow enough and refuses clips past five minutes', () => {
    const plan = cutoutPlan(clip(120), { width: 1080, height: 1920 });
    expect(plan.frames).toBe(CUTOUT_MAX_FRAMES);
    expect(plan.fps).toBe(2.5);
    expect(plan.columns * plan.matteWidth).toBeLessThanOrEqual(CUTOUT_ATLAS_MAX_WIDTH);
    expect(plan.columns * plan.rows).toBeGreaterThanOrEqual(plan.frames);
    expect(() => cutoutPlan(clip(301), { width: 1920, height: 1080 })).toThrow(BadRequestException);
  });

  it('places each matte frame row after row', () => {
    const plan = { columns: 3, matteWidth: 10, matteHeight: 6 };
    expect([0, 2, 3, 7].map((index) => atlasCell(plan, index))).toEqual([
      { left: 0, top: 0 },
      { left: 20, top: 0 },
      { left: 0, top: 6 },
      { left: 10, top: 12 },
    ]);
  });

  it('maps painted points to frames of the window and drops the ones outside it', () => {
    const plan = cutoutPlan(clip(2), { width: 1920, height: 1080 });
    expect(
      workerPoints(plan, [
        { sourceSeconds: 3.5, x: 0.5, y: 0.25, label: 1 },
        { sourceSeconds: 2, x: 0.5, y: 0.5, label: 0 },
        { sourceSeconds: 6, x: 0.5, y: 0.5, label: 0 },
      ]),
    ).toEqual([{ frame: 5, x: 0.5, y: 0.25, label: 1 }]);
  });

  it('finds the chosen person again on the first frame, by face recognition or else by position', () => {
    expect(matchFirstFrameFace(firstFrame, [0.4, 0.1, 0.6, 0.3], '[1, 0, 0]')).toEqual([0.7, 0.2, 0.8, 0.4]);
    // Nobody similar enough: no seed rather than someone else.
    expect(matchFirstFrameFace(firstFrame, [0.4, 0.1, 0.6, 0.3], '[0, 0, 1]')).toBeNull();
    // No library embedding: the face nearest the library box.
    expect(matchFirstFrameFace(firstFrame, [0.05, 0.1, 0.15, 0.3], null)).toEqual([0.1, 0.1, 0.2, 0.3]);
    expect(matchFirstFrameFace({ ...firstFrame, faces: [] }, [0.4, 0.1, 0.6, 0.3], null)).toBeNull();
  });

  it('gives every cut-out a deadline that grows with its frames, up to an hour', () => {
    expect(cutoutDeadlineMs(20)).toBe(320_000);
    expect(cutoutDeadlineMs(100_000)).toBe(3_600_000);
  });

  it('reads face boxes as fractions of the picture', () => {
    expect(faceFraction(face(jamie, 'Jamie', 400, 600))).toEqual([0.4, 0.1, 0.6, 0.3]);
    expect(faceFraction({ ...face(jamie, 'Jamie', 400, 600), imageWidth: 0 })).toBeNull();
  });

  it('lays the mattes out as one grayscale PNG with gaps left empty', async () => {
    const atlas = await composeAtlas({ columns: 2, rows: 2, matteWidth: 4, matteHeight: 2 }, [
      await grayPng(4, 2, 255),
      undefined,
      await grayPng(8, 4, 100),
    ]);
    expect((await sharp(atlas).metadata()).channels).toBe(1);
    const { data, info } = await sharp(atlas).toColourspace('b-w').raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height, info.channels]).toEqual([8, 4, 1]);
    expect([data[0], data[4], data[2 * 8]]).toEqual([255, 0, 100]);
  });
});

describe(StudioCutoutService.name, () => {
  beforeEach(async () => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    incomingFolder = await mkdtemp(path.join(tmpdir(), 'cutout-spec-'));
    vi.mocked(selectMlDestination).mockReset();
    vi.mocked(homeMlDestinationId).mockReset();
  });

  it('offers the named, visible people in the clip, largest face first', async () => {
    const { sut, persons } = setup({
      faces: [
        face(sam, 'Sam', 100, 150),
        face(jamie, 'Jamie', 400, 600),
        face(jamie, 'Jamie', 400, 450),
        face(null, '', 700, 900),
        face('0195e2a0-0000-4000-8000-000000000035', 'Hidden', 0, 500, true),
      ],
    });
    await expect(sut.subjects(authStub.user1, projectId, 'clip')).resolves.toEqual({
      subjects: [
        { kind: 'person', personId: jamie, name: 'Jamie' },
        { kind: 'person', personId: sam, name: 'Sam' },
      ],
    });
    expect(persons.getFaces).toHaveBeenCalledWith(assetId, { viewingUserId: authStub.user1.user.id });
  });

  it('offers the main subject when no one is recognised', async () => {
    const { sut } = setup({ faces: [] });
    await expect(sut.subjects(authStub.user1, projectId, 'clip')).resolves.toEqual({
      subjects: [{ kind: 'subject', personId: null, name: null }],
    });
  });

  it('refuses a clip that is not a video, and anyone but the owner', async () => {
    const { sut, studio } = setup();
    await expect(sut.subjects(authStub.user1, projectId, 'song')).rejects.toThrow('Only a video clip');
    await expect(sut.subjects(authStub.user1, projectId, 'missing')).rejects.toThrow('try again shortly');
    await expect(sut.subjects(authStub.adminSharedLink, projectId, 'clip')).rejects.toThrow(NotFoundException);
    studio.requireOwnedProject.mockRejectedValue(new NotFoundException('Studio project not found'));
    await expect(sut.subjects(someoneElse, projectId, 'clip')).rejects.toThrow(NotFoundException);
  });

  it('follows Jamie from their face through the clip and keeps the matte with the project', async () => {
    const { sut, clips, machineLearning, imports, uploads } = setup();
    const queued = await sut.create(authStub.user1, projectId, {
      clipId: 'clip',
      personId: jamie,
      points: [{ sourceSeconds: 3.1, x: 0.5, y: 0.5, label: 0 }],
    });
    expect(queued).toMatchObject({ status: 'queued', subject: { kind: 'person', personId: jamie, name: 'Jamie' } });
    const job = await settled(sut, queued.id);
    expect(job.error).toBeNull();
    expect(job.status).toBe('completed');
    expect(clips.extractFrames).toHaveBeenCalledWith(
      '/library/clip.mov',
      expect.any(String),
      { startSeconds: '3.000000', durationSeconds: '2.000000' },
      { fps: 10, frames: 20, width: 640, height: 360 },
      expect.any(AbortSignal),
    );
    // First-frame face detection runs under the cut-out's own deadline.
    expect(machineLearning.detectFaces).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/00001\.jpg$/),
      { modelName: 'buffalo_l', minScore: 0.7 },
      expect.any(AbortSignal),
    );
    const [selection, framePaths, options] = machineLearning.subjectMatte.mock.calls[0];
    expect(selection).toMatchObject({ destinationId });
    expect(framePaths).toHaveLength(3);
    expect(options).toEqual({
      seedKind: 'face',
      // Jamie found again on the clip's first frame, not the cover picture's box.
      seedBox: [0.7, 0.2, 0.8, 0.4],
      points: [{ frame: 1, x: 0.5, y: 0.5, label: 0 }],
      matteWidth: 192,
      matteHeight: 108,
    });
    expect(imports.upload).toHaveBeenCalledOnce();
    expect(uploads[0].name).toBe(`frameleaf-subject-matte-${uploads[0].id}.png`);
    const atlas = await sharp(uploads[0].png).metadata();
    expect([atlas.format, atlas.width, atlas.height]).toEqual(['png', 3 * 192, 108]);
    expect(job.matte).toEqual({
      importId: uploads[0].id,
      startSeconds: 3,
      durationSeconds: 2,
      fps: 10,
      frames: 3,
      columns: 3,
      frameWidth: 192,
      frameHeight: 108,
    });
    expect(job.progress).toBe(100);
  });

  it("refuses a person who is not in the clip's first frame, or when face recognition is off", async () => {
    const elsewhere = setup({ detected: { ...firstFrame, faces: [firstFrame.faces[0]] } });
    const refused = await settled(
      elsewhere.sut,
      (await elsewhere.sut.create(authStub.user1, projectId, { clipId: 'clip', personId: jamie, points: [] })).id,
    );
    expect(refused).toMatchObject({ status: 'failed', errorCode: 'personNotInFirstFrame' });
    expect(refused.error).toContain("isn't in the clip's first frame");
    expect(elsewhere.machineLearning.subjectMatte).not.toHaveBeenCalled();

    // The library's cover-picture box could be someone else on this clip: no person cut-out without detection.
    const offline = setup({ faceDetection: false });
    const off = await settled(
      offline.sut,
      (await offline.sut.create(authStub.user1, projectId, { clipId: 'clip', personId: jamie, points: [] })).id,
    );
    expect(off).toMatchObject({ status: 'failed', errorCode: 'faceDetectionOff', matte: null });
    expect(offline.clips.extractFrames).not.toHaveBeenCalled();
    expect(offline.machineLearning.subjectMatte).not.toHaveBeenCalled();
    // Main subject still works.
    const main = await settled(
      offline.sut,
      (await offline.sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] })).id,
    );
    expect(main).toMatchObject({ status: 'completed', errorCode: null });
  });

  it('holds the per-person limit for creations still being admitted', async () => {
    const { sut } = setup();
    const request = { clipId: 'clip', personId: null, points: [] };
    const results = await Promise.allSettled([
      sut.create(authStub.user1, projectId, request),
      sut.create(authStub.user1, projectId, request),
      sut.create(authStub.user1, projectId, request),
    ]);
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        await settled(sut, result.value.id);
      }
    }
    // Settled jobs and finished admissions free the slots again.
    await expect(sut.create(authStub.user1, projectId, request)).resolves.toMatchObject({ status: 'queued' });
  });

  it('stops a cut-out the worker never finishes, so later ones can run', async () => {
    vi.mocked(cutoutDeadlineMs).mockReturnValueOnce(50);
    const stalled = setup({
      matte: (...args: any[]) =>
        new Promise((_resolve, reject) => {
          const signal = args[3] as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    });
    const job = await settled(
      stalled.sut,
      (await stalled.sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] })).id,
    );
    expect(job).toMatchObject({ status: 'failed', matte: null });
    expect(job.error).toContain('took too long');
  });

  it('follows the main subject when no person is chosen', async () => {
    const { sut, machineLearning } = setup({ faces: [] });
    const job = await settled(
      sut,
      (await sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] })).id,
    );
    expect(job.status).toBe('completed');
    expect(machineLearning.subjectMatte.mock.calls[0][2]).toMatchObject({ seedKind: 'subject', seedBox: null });
  });

  it('refuses a person not recognised in the clip', async () => {
    const { sut } = setup();
    await expect(
      sut.create(authStub.user1, projectId, {
        clipId: 'clip',
        personId: '0195e2a0-0000-4000-8000-000000000099',
        points: [],
      }),
    ).rejects.toThrow('not recognised');
  });

  it('never sends the frames to Frameleaf Cloud', async () => {
    const { sut, machineLearning } = setup({ kind: MlDestinationKind.FrameleafCloud });
    await expect(sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] })).rejects.toThrow(
      'not on Frameleaf Cloud',
    );
    expect(machineLearning.subjectMatte).not.toHaveBeenCalled();
    expect(vi.mocked(selectMlDestination)).not.toHaveBeenCalled();
  });

  it('asks for home machine learning when none can take the work', async () => {
    const { sut } = setup();
    vi.mocked(homeMlDestinationId).mockRejectedValue(new Error('no local'));
    await expect(sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] })).rejects.toThrow(
      ServiceUnavailableException,
    );
  });

  it('says plainly why a cut-out failed and keeps nothing', async () => {
    const worker = setup({
      matte: () => Promise.reject(new CutoutWorkerError('No subject found in the first frame')),
    });
    const failed = await settled(
      worker.sut,
      (await worker.sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] })).id,
    );
    expect(failed).toMatchObject({ status: 'failed', error: 'No subject found in the first frame', matte: null });
    expect(worker.imports.upload).not.toHaveBeenCalled();

    const unavailable = setup({ matte: () => Promise.reject(new CutoutUnavailableError('503')) });
    const missing = await settled(
      unavailable.sut,
      (await unavailable.sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] })).id,
    );
    expect(missing.error).toBe('The machine learning that cuts out subjects is not set up on this server or computer');
  });

  it('answers a cut-out only to its owner, for its project', async () => {
    const { sut } = setup();
    const { id } = await sut.create(authStub.user1, projectId, { clipId: 'clip', personId: null, points: [] });
    await settled(sut, id);
    expect(() => sut.get(someoneElse, projectId, id)).toThrow(NotFoundException);
    expect(() => sut.get(authStub.user1, '0195e2a0-0000-7000-8000-000000000098', id)).toThrow(NotFoundException);
  });
});
