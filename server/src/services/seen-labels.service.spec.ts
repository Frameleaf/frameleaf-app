import { MlWorkload } from 'src/enum.js';
import { SEEN_LABELS, SeenLabelsService } from 'src/services/seen-labels.service.js';
import { mlDestinationStub, mlSelectionStub } from 'test/fixtures/ml-destination.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(SeenLabelsService.name, () => {
  let sut: SeenLabelsService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SeenLabelsService));
    mocks.mlDestination.getAll.mockResolvedValue([mlDestinationStub.local]);
    mocks.mlDestination.getRoute.mockResolvedValue(undefined);
    // the computer that encodes search text
    vi.spyOn(
      sut as unknown as { selectClipTextDestination: () => Promise<unknown> },
      'selectClipTextDestination',
    ).mockResolvedValue(mlSelectionStub(MlWorkload.Clip));
    mocks.machineLearning.encodeText.mockImplementation((_selection, text) => Promise.resolve(`[${text.length}]`));
  });

  it('encodes each everyday subject as "a photo of …" once per CLIP model', async () => {
    mocks.machineLearning.clipCacheKey.mockResolvedValue('model-a');
    const first = await sut.labels();
    expect(first).toHaveLength(Object.keys(SEEN_LABELS).length);
    expect(mocks.machineLearning.encodeText).toHaveBeenCalledWith(expect.anything(), 'a photo of mountains', {
      modelName: expect.any(String),
    });
    const calls = mocks.machineLearning.encodeText.mock.calls.length;
    expect(await sut.labels()).toBe(first);
    expect(mocks.machineLearning.encodeText.mock.calls.length).toBe(calls);
  });

  it('goes without when the text cannot be encoded', async () => {
    mocks.machineLearning.clipCacheKey.mockResolvedValue('model-b');
    mocks.machineLearning.encodeText.mockRejectedValue(new Error('not answering'));
    await expect(sut.labels()).resolves.toBeUndefined();
  });
});
