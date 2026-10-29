import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { StudioCaptionTranslationCreateDto } from 'src/dtos/studio-caption-translation.dto.js';
import { MlProcessingSource, MlWorkload } from 'src/enum.js';
import { TranslationUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { StudioCaptionTranslationService } from 'src/services/studio-caption-translation.service.js';
import { selectMlDestination } from 'src/utils/ml-destination.js';
import { authStub } from 'test/fixtures/auth.stub.js';

vi.mock('src/utils/ml-destination.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/ml-destination.js')>()),
  selectMlDestination: vi.fn(),
}));

const projectId = '0195e2a0-0000-7000-8000-000000000010';
const owner = { ...authStub.user1, user: { ...authStub.user1.user, id: '0195e2a0-0000-7000-8000-000000000014' } };
const local = '0195e2a0-0000-4000-8000-000000000031';
const lan = '0195e2a0-0000-4000-8000-000000000032';
const cloud = '0195e2a0-0000-4000-8000-000000000033';
const desktopPool = '0195e2a0-0000-4000-8000-000000000034';

const request = { source: 'en', target: 'fr', lines: ['Good morning', '', 'See you soon'] } as const;

const setup = (
  route = [
    { source: MlProcessingSource.Local, destinationId: local, desktopPool: false, available: true },
    { source: MlProcessingSource.Desktops, destinationId: lan, desktopPool: false, available: true },
    { source: MlProcessingSource.Cloud, destinationId: cloud, desktopPool: false, available: true },
  ],
) => {
  const studio = { requireOwnedProject: vi.fn().mockResolvedValue({ id: projectId }) };
  const machineLearning = {
    translateCaptions: vi
      .fn()
      .mockImplementation((_selection, options: { lines: string[] }) =>
        Promise.resolve({ model: 'm2m100-418m', translations: options.lines.map((line) => line && `fr:${line}`) }),
      ),
  };
  const mlDestinations = { resolveRoute: vi.fn().mockResolvedValue(route) };
  vi.mocked(selectMlDestination).mockImplementation((_deps, selectionRequest) =>
    Promise.resolve({
      destinationId: selectionRequest.destinationId,
      workload: MlWorkload.StudioAi,
      endpoint: { url: `http://${selectionRequest.destinationId}` },
    } as never),
  );
  const logger = { setContext: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const sut = new StudioCaptionTranslationService(
    logger as never,
    studio as never,
    machineLearning as never,
    mlDestinations as never,
  );
  return { sut, studio, machineLearning, mlDestinations };
};

describe(StudioCaptionTranslationService.name, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('translates on this server first and keeps every line in order', async () => {
    const { sut, studio, machineLearning, mlDestinations } = setup();
    await expect(sut.translate(owner, projectId, request)).resolves.toEqual({
      source: 'en',
      target: 'fr',
      lines: ['fr:Good morning', '', 'fr:See you soon'],
      model: 'm2m100-418m',
      destinationId: local,
    });
    expect(studio.requireOwnedProject).toHaveBeenCalledWith(owner, projectId, expect.any(String));
    expect(mlDestinations.resolveRoute).toHaveBeenCalledWith(MlWorkload.StudioAi);
    expect(selectMlDestination).toHaveBeenCalledTimes(1);
    expect(vi.mocked(selectMlDestination).mock.calls[0][1]).toMatchObject({
      workload: MlWorkload.StudioAi,
      destinationId: local,
      desktopPool: 'skip',
    });
    // Only the text leaves: the source and target languages and the lines.
    expect(machineLearning.translateCaptions).toHaveBeenCalledWith(
      expect.objectContaining({ destinationId: local }),
      { source: 'en', target: 'fr', lines: request.lines },
      expect.any(AbortSignal),
    );
  });

  it('passes over a place that cannot translate for the next in the order', async () => {
    const { sut, machineLearning } = setup();
    machineLearning.translateCaptions.mockRejectedValueOnce(new TranslationUnavailableError('no model'));
    const result = await sut.translate(owner, projectId, request);
    expect(result.destinationId).toBe(lan);
    expect(machineLearning.translateCaptions).toHaveBeenCalledTimes(2);
  });

  it('passes over a place that refuses admission', async () => {
    const { sut } = setup();
    vi.mocked(selectMlDestination).mockRejectedValueOnce(new BadRequestException('unhealthy'));
    await expect(sut.translate(owner, projectId, request)).resolves.toMatchObject({ destinationId: lan });
  });

  it('never sends the text to Frameleaf Cloud', async () => {
    const { sut, machineLearning } = setup([
      { source: MlProcessingSource.Cloud, destinationId: cloud, desktopPool: false, available: true },
    ]);
    await expect(sut.translate(owner, projectId, request)).rejects.toThrow(
      'Captions are translated on this server or a computer at home, and none is available now.',
    );
    expect(selectMlDestination).not.toHaveBeenCalled();
    expect(machineLearning.translateCaptions).not.toHaveBeenCalled();
  });

  it('skips places that are not available and the desktop assistance pool', async () => {
    const { sut, machineLearning } = setup([
      { source: MlProcessingSource.Local, destinationId: local, desktopPool: false, available: false },
      { source: MlProcessingSource.Desktops, destinationId: desktopPool, desktopPool: true, available: true },
    ]);
    await expect(sut.translate(owner, projectId, request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(machineLearning.translateCaptions).not.toHaveBeenCalled();
  });

  it('says so when nowhere can translate', async () => {
    const { sut, machineLearning } = setup();
    machineLearning.translateCaptions.mockRejectedValue(new TranslationUnavailableError('no route'));
    await expect(sut.translate(owner, projectId, request)).rejects.toBeInstanceOf(ServiceUnavailableException);
    // Local and the computer at home were tried; the cloud never was.
    expect(machineLearning.translateCaptions).toHaveBeenCalledTimes(2);
  });

  it('stops on a failed translation instead of trying elsewhere', async () => {
    const { sut, machineLearning } = setup();
    machineLearning.translateCaptions.mockRejectedValueOnce(new Error('worker crashed'));
    await expect(sut.translate(owner, projectId, request)).rejects.toThrow(
      'The captions could not be translated. Try again.',
    );
    expect(machineLearning.translateCaptions).toHaveBeenCalledTimes(1);
  });

  it('is for the project owner only', async () => {
    const { sut, studio, machineLearning } = setup();
    studio.requireOwnedProject.mockRejectedValueOnce(new ForbiddenException('owner only'));
    await expect(sut.translate(owner, projectId, request)).rejects.toBeInstanceOf(ForbiddenException);
    expect(machineLearning.translateCaptions).not.toHaveBeenCalled();
  });

  it('is never offered through a shared link', async () => {
    const { sut, studio } = setup();
    await expect(sut.translate(authStub.adminSharedLink, projectId, request)).rejects.toBeInstanceOf(NotFoundException);
    expect(studio.requireOwnedProject).not.toHaveBeenCalled();
  });
});

describe(StudioCaptionTranslationCreateDto.name, () => {
  const parse = (value: unknown) => StudioCaptionTranslationCreateDto.schema.safeParse(value);

  it('accepts the app languages', () => {
    expect(parse({ source: 'en', target: 'nb', lines: ['Hi'] }).success).toBe(true);
    expect(parse({ source: 'pt', target: 'da', lines: ['Olá'] }).success).toBe(true);
  });

  it('refuses other languages, the same language and oversized requests', () => {
    expect(parse({ source: 'en', target: 'ja', lines: ['Hi'] }).success).toBe(false);
    expect(parse({ source: 'en', target: 'en', lines: ['Hi'] }).success).toBe(false);
    expect(parse({ source: 'en', target: 'fr', lines: [] }).success).toBe(false);
    expect(parse({ source: 'en', target: 'fr', lines: Array.from({ length: 2001 }, () => 'x') }).success).toBe(false);
    expect(parse({ source: 'en', target: 'fr', lines: ['x'.repeat(1001)] }).success).toBe(false);
  });
});
