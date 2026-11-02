import { NotFoundException } from '@nestjs/common';
import { MlWorkload } from 'src/enum.js';
import { StudioReframeService } from 'src/services/studio-reframe.service.js';
import { getConfig } from 'src/utils/config.js';
import { homeMlDestinationId, selectMlDestination } from 'src/utils/ml-destination.js';
import { StudioDestination, StudioResourceKind } from 'src/utils/studio-resources.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { probeStub } from 'test/fixtures/media.stub.js';

vi.mock('src/utils/ml-destination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/ml-destination.js')>()),
  selectMlDestination: vi.fn(),
  homeMlDestinationId: vi.fn(),
}));
vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/config.js')>()),
  getConfig: vi.fn(),
}));

const projectId = '0195e2a0-0000-7000-8000-000000000020';
const videoAsset = '0195e2a0-0000-4000-8000-000000000021';
const photoAsset = '0195e2a0-0000-4000-8000-000000000022';
const unsharedAsset = '0195e2a0-0000-4000-8000-000000000023';
const destinationId = '0195e2a0-0000-4000-8000-000000000024';

const graph = {
  metadata: { width: 1920, height: 1080 },
  timeline: {
    tracks: [{ id: 'v1', order: 0 }],
    items: [
      {
        id: 'clip',
        type: 'video',
        mediaId: videoAsset,
        from: 0,
        durationInFrames: 300,
        sourceStart: 0,
        sourceEnd: 300,
        sourceFps: 30,
        sourceWidth: 1920,
        sourceHeight: 1080,
      },
      {
        id: 'photo',
        type: 'image',
        mediaId: photoAsset,
        from: 300,
        durationInFrames: 90,
        sourceWidth: 4000,
        sourceHeight: 2250,
      },
      {
        id: 'other',
        type: 'image',
        mediaId: unsharedAsset,
        from: 390,
        durationInFrames: 90,
        sourceWidth: 1920,
        sourceHeight: 1080,
      },
      { id: 'title', type: 'text', text: 'Hi', from: 0, durationInFrames: 30 },
    ],
  },
};

const box = (x1: number, x2: number) => ({
  boundingBoxX1: x1,
  boundingBoxX2: x2,
  boundingBoxY1: 100,
  boundingBoxY2: 300,
  imageWidth: 1000,
  imageHeight: 1000,
});

const setup = ({ faceDetection = true, detected = [0.3, 0.5, 0.7] as Array<number | null> } = {}) => {
  const studio = {
    requireOwnedProject: vi.fn().mockResolvedValue({}),
    authorizeRevision: vi.fn().mockResolvedValue({
      revision: { revision: 7 },
      envelope: { graph },
      manifest: {
        entries: [
          {
            key: `library-asset:${videoAsset}`,
            kind: StudioResourceKind.LibraryAsset,
            id: videoAsset,
            sourceAccess: 'owner',
          },
          {
            key: `library-asset:${photoAsset}`,
            kind: StudioResourceKind.LibraryAsset,
            id: photoAsset,
            sourceAccess: 'shared',
          },
        ],
      },
    }),
  };
  const persons = {
    getFaces: vi
      .fn()
      .mockImplementation((assetId: string) =>
        Promise.resolve(assetId === photoAsset ? [box(700, 900)] : assetId === videoAsset ? [box(450, 550)] : []),
      ),
  };
  const assetJobs = {
    getForVideoDuplicateFrameJob: vi.fn().mockResolvedValue({
      id: videoAsset,
      originalPath: '/library/clip.mov',
      videoStream: probeStub.videoStream2160p.videoStream!,
      format: { ...probeStub.videoStream2160p.format, duration: 10_000 },
    }),
  };
  const media = { transcode: vi.fn().mockResolvedValue(undefined) };
  let call = 0;
  const machineLearning = {
    detectFaces: vi.fn().mockImplementation(() => {
      const x = detected[call++ % detected.length];
      return Promise.resolve({
        imageWidth: 1000,
        imageHeight: 1000,
        faces:
          x === null
            ? []
            : [
                {
                  boundingBox: { x1: x * 1000 - 50, x2: x * 1000 + 50, y1: 100, y2: 200 },
                  embedding: '[]',
                  score: 0.9,
                },
              ],
      });
    }),
  };
  vi.mocked(getConfig).mockResolvedValue({
    machineLearning: {
      enabled: true,
      urls: ['http://ml:3003'],
      facialRecognition: { enabled: faceDetection, modelName: 'buffalo_l', minScore: 0.7 },
    },
    ffmpeg: {},
    image: { preview: { size: 1440 } },
  } as never);
  vi.mocked(homeMlDestinationId).mockResolvedValue(destinationId);
  vi.mocked(selectMlDestination).mockResolvedValue({ destinationId, workload: MlWorkload.Face } as never);
  const logger = { setContext: vi.fn(), debug: vi.fn((m: string) => console.log('DEBUG', m)) };
  const sut = new StudioReframeService(
    logger as never,
    studio as never,
    persons as never,
    assetJobs as never,
    media as never,
    machineLearning as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { sut, studio, persons, media, machineLearning };
};

describe(StudioReframeService.name, () => {
  beforeEach(() => {
    vi.mocked(selectMlDestination).mockReset();
    vi.mocked(homeMlDestinationId).mockReset();
  });

  it('follows faces through each shot of the head revision, centring what it cannot read', async () => {
    const { sut, studio, media, machineLearning } = setup();
    const framing = await sut.framing(authStub.user1, projectId);
    expect(studio.authorizeRevision).toHaveBeenCalledWith(authStub.user1, {
      projectId,
      destination: StudioDestination.Local,
    });
    expect(framing).toMatchObject({ revision: 7, width: 1920, height: 1080 });
    expect(framing.shots.map((shot) => [shot.clipId, shot.type, shot.assetId, shot.subject])).toEqual([
      ['clip', 'video', videoAsset, 'face'],
      ['photo', 'image', photoAsset, 'face'],
      ['other', 'image', null, 'none'],
    ]);
    // three frames sampled through the part of the clip the shot uses, smoothed
    expect(media.transcode).toHaveBeenCalledTimes(3);
    expect(machineLearning.detectFaces).toHaveBeenCalledTimes(3);
    expect(framing.shots[0].path).toEqual([
      { t: 0.15, x: 0.35 },
      { t: 0.5, x: 0.5 },
      { t: 0.85, x: 0.65 },
    ]);
    // a still answers its library faces, through its box on the canvas
    expect(framing.shots[1].path).toEqual([{ t: 0.5, x: 0.8 }]);
    // media this session cannot read is never looked at
    expect(framing.shots[2].path).toEqual([{ t: 0.5, x: 0.5 }]);
  });

  it('remembers sampled frames, so opening the dialog again sends nothing to face detection', async () => {
    const { sut, machineLearning } = setup();
    await sut.framing(authStub.user1, projectId);
    await sut.framing(authStub.user1, projectId);
    expect(machineLearning.detectFaces).toHaveBeenCalledTimes(3);
  });

  it('uses the library faces alone when face detection is off', async () => {
    const { sut, machineLearning } = setup({ faceDetection: false });
    const framing = await sut.framing(authStub.user1, projectId);
    expect(machineLearning.detectFaces).not.toHaveBeenCalled();
    expect(framing.shots[0]).toMatchObject({ subject: 'face', path: [{ t: 0.5, x: 0.5 }] });
  });

  it('falls back to the library faces when no home destination can take face detection', async () => {
    const { sut, machineLearning } = setup();
    vi.mocked(homeMlDestinationId).mockRejectedValue(new Error('not routed'));
    const framing = await sut.framing(authStub.user1, projectId);
    expect(machineLearning.detectFaces).not.toHaveBeenCalled();
    expect(framing.shots[0].subject).toBe('face');
  });

  it('only sends face detection to this network', async () => {
    const { sut } = setup();
    await sut.framing(authStub.user1, projectId);
    expect(selectMlDestination).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ workload: MlWorkload.Face, destinationId, homeOnly: true }),
    );
  });

  it('fills frames without a face from their neighbours', async () => {
    const { sut } = setup({ detected: [0.2, null, 0.8] });
    const framing = await sut.framing(authStub.user1, projectId);
    expect(framing.shots[0].path.map((point) => point.x)).toEqual([0.2, 0.35, 0.65]);
  });

  it('answers 404 to a shared link', async () => {
    const { sut } = setup();
    await expect(sut.framing(authStub.adminSharedLink, projectId)).rejects.toBeInstanceOf(NotFoundException);
  });
});
