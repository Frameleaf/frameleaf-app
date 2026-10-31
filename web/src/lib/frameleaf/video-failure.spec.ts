import { describeVideoFailure } from '$lib/frameleaf/video-failure';

// HTMLMediaElement error codes (MediaError.MEDIA_ERR_*), spelled out because jsdom has no MediaError.
const ABORTED = 1;
const NETWORK = 2;
const DECODE = 3;
const SRC_NOT_SUPPORTED = 4;

describe('describeVideoFailure', () => {
  it('reports a decode failure as one, whatever the container', () => {
    expect(describeVideoFailure({ code: DECODE }, 'probably')).toBe('decode');
    expect(describeVideoFailure({ code: DECODE }, '')).toBe('decode');
  });

  it('reports an unplayable format only when the browser rules the file type out', () => {
    expect(describeVideoFailure({ code: SRC_NOT_SUPPORTED }, '')).toBe('format');
  });

  it('does not blame the format when the browser might play the file type', () => {
    // Browsers also report a missing or unreachable file as "source not supported".
    expect(describeVideoFailure({ code: SRC_NOT_SUPPORTED }, 'maybe')).toBe('load');
    expect(describeVideoFailure({ code: SRC_NOT_SUPPORTED }, 'probably')).toBe('load');
  });

  it('reports network, aborted and unknown failures as a load failure', () => {
    expect(describeVideoFailure({ code: NETWORK }, '')).toBe('load');
    expect(describeVideoFailure({ code: ABORTED }, '')).toBe('load');
    expect(describeVideoFailure(null, '')).toBe('load');
    expect(describeVideoFailure(undefined, '')).toBe('load');
  });
});
