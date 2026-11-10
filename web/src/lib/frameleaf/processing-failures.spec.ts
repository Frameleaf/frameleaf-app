import { ProcessingFailureStep, type ProcessingFailureResponseDto } from '@frameleaf/sdk';
import { getProcessingFailures } from '@frameleaf/sdk';
import {
  actionItems,
  causeWords,
  groupFailures,
  isRetrying,
  processingFailureCounts,
  stepWords,
} from '$lib/frameleaf/processing-failures';

vi.mock('@frameleaf/sdk', async (original) => ({ ...(await original<object>()), getProcessingFailures: vi.fn() }));

const row = (overrides: Partial<ProcessingFailureResponseDto>): ProcessingFailureResponseDto => ({
  assetId: 'a1',
  step: ProcessingFailureStep.AssetEncodeVideo,
  cause: 'unreadable',
  attempts: 1,
  lastFailedAt: '2026-11-10T08:00:00.000Z',
  quarantinedAt: null,
  ownerId: 'u1',
  ownerName: 'Taylor',
  fileName: 'VID_0001.MOV',
  ...overrides,
});

describe('processing failures (FL-862)', () => {
  it('lists a file once with its newest failure, and acts on every step of it', () => {
    const files = groupFailures([
      row({ attempts: 1 }),
      row({ step: ProcessingFailureStep.Ocr, attempts: 3, quarantinedAt: '2026-11-09T08:00:00.000Z' }),
      row({ assetId: 'a2', fileName: 'IMG_0002.HEIC', cause: 'too-large' }),
    ]);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ step: ProcessingFailureStep.AssetEncodeVideo, attempts: 3, setAside: true });
    expect(files[0].isVideo).toBe(true);
    expect(files[1].isVideo).toBe(false);
    expect(actionItems(files.slice(0, 1))).toEqual([
      { assetId: 'a1', step: ProcessingFailureStep.AssetEncodeVideo },
      { assetId: 'a1', step: ProcessingFailureStep.Ocr },
    ]);
    expect(isRetrying(groupFailures([row({ attempts: 0 })])[0])).toBe(true);
  });

  it('words each cause for a photo or a video, and each step', () => {
    expect(causeWords({ cause: 'timed-out', isVideo: true })).toBe('frameleaf_processing_failure_timed_out_video');
    expect(causeWords({ cause: 'too-large', isVideo: false })).toBe('frameleaf_processing_failure_too_large_photo');
    expect(causeWords({ cause: 'something new', isVideo: false })).toBe('frameleaf_processing_failure_other_photo');
    expect(stepWords(ProcessingFailureStep.SmartSearch)).toBe('frameleaf_processing_failure_step_search');
  });

  it('reads every page before counting, so one file is never split and nothing is left out', async () => {
    const page = (from: number, count: number) =>
      Array.from({ length: count }, (_, index) => row({ assetId: `a${Math.floor((from + index) / 2)}` }));
    vi.mocked(getProcessingFailures).mockResolvedValueOnce(page(0, 200)).mockResolvedValueOnce(page(200, 3));
    expect(await processingFailureCounts()).toEqual({ count: 102, setAside: 0 });
    expect(getProcessingFailures).toHaveBeenNthCalledWith(1, { skip: 0, take: 200 });
    expect(getProcessingFailures).toHaveBeenNthCalledWith(2, { skip: 200, take: 200 });
  });
});
