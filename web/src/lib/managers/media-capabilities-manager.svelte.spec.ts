// Regression coverage for a bug where H.264 levels were hardcoded as always
// supported/powerEfficient/smooth instead of asking `navigator.mediaCapabilities`
// what the running browser can actually decode. On a platform without an H.264
// decoder (e.g. Playwright's arm64 Linux Chromium), that hid the fact that H.264
// renditions could not actually be played.
//
// `efficientLevels()` also has to fall back correctly once the queries are real: before this
// fix, H.264 being hardcoded powerEfficient always guaranteed at least one surviving rendition.
// With real queries, a browser that only decodes in software (no hardware acceleration) reports
// every codec as supported-but-not-powerEfficient, and previously that meant every level got
// removed and playback broke. The three tiers below (powerEfficient -> supported -> keep
// everything) are each covered.
//
// `mediaCapabilitiesManager.init()` runs as a module-level side effect, so each
// test re-imports the module after installing its own `navigator.mediaCapabilities`
// mock to get a fresh cache built against that mock.
const decodingInfo = vi.fn();

const stubMediaCapabilities = () => {
  Object.defineProperty(navigator, 'mediaCapabilities', {
    configurable: true,
    value: { decodingInfo },
  });
};

// H.264 is the only codec family the manager used to special-case away from a real query.
const isH264 = (contentType: string) => contentType.includes('avc1');

beforeEach(() => {
  vi.resetModules();
  decodingInfo.mockReset();
});

afterEach(() => {
  // @ts-expect-error -- test-only cleanup of a property we defined for the test
  delete navigator.mediaCapabilities;
});

it('queries mediaCapabilities for an H.264 level instead of assuming it is always supported', async () => {
  decodingInfo.mockImplementation(({ video }: { video: { contentType: string } }) =>
    Promise.resolve({
      supported: !isH264(video.contentType),
      powerEfficient: !isH264(video.contentType),
      smooth: !isH264(video.contentType),
      keySystemAccess: null,
    }),
  );
  stubMediaCapabilities();

  const { mediaCapabilitiesManager } = await import('./media-capabilities-manager.svelte');

  const h264Level = { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 2_500_000, frameRate: 60 };
  const info = await mediaCapabilitiesManager.decodingInfo(h264Level);

  expect(decodingInfo).toHaveBeenCalledWith(
    expect.objectContaining({
      video: expect.objectContaining({ contentType: expect.stringContaining('avc1.64001e') }),
    }),
  );
  expect(info).toEqual({ supported: false, powerEfficient: false, smooth: false, keySystemAccess: null });
});

it('drops H.264 renditions a browser without an H.264 decoder cannot actually play', async () => {
  decodingInfo.mockImplementation(({ video }: { video: { contentType: string } }) =>
    Promise.resolve({
      supported: !isH264(video.contentType),
      powerEfficient: !isH264(video.contentType),
      smooth: !isH264(video.contentType),
      keySystemAccess: null,
    }),
  );
  stubMediaCapabilities();

  const { mediaCapabilitiesManager } = await import('./media-capabilities-manager.svelte');

  const levels = [
    { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 2_500_000, frameRate: 60 },
    { videoCodec: 'hvc1.1.6.L90.B0', width: 854, height: 480, bitrate: 1_200_000, frameRate: 60 },
  ];
  const keep = await mediaCapabilitiesManager.efficientLevels(levels);

  expect(keep).toEqual(new Set([1]));
});

it('falls back to the lowest-bitrate supported level per height when nothing is power-efficient', async () => {
  // All software-decoded: supported, but not powerEfficient - common without hardware
  // acceleration (VA-API-less Linux desktops, many VMs, Firefox on some platforms).
  decodingInfo.mockImplementation(() =>
    Promise.resolve({ supported: true, powerEfficient: false, smooth: true, keySystemAccess: null }),
  );
  stubMediaCapabilities();

  const { mediaCapabilitiesManager } = await import('./media-capabilities-manager.svelte');

  const levels = [
    { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 2_500_000, frameRate: 60 },
    { videoCodec: 'hvc1.1.6.L90.B0', width: 854, height: 480, bitrate: 1_200_000, frameRate: 60 },
  ];
  const keep = await mediaCapabilitiesManager.efficientLevels(levels);

  // Neither level is powerEfficient, so the fallback tier picks the lowest-bitrate supported
  // level at this height (index 1) instead of removing every level.
  expect(keep).toEqual(new Set([1]));
});

it('keeps every level, rather than removing them all, when nothing is even supported', async () => {
  // e.g. Playwright's arm64 Linux Chromium build, which has no H.264 decoder at all and nothing
  // else declared supported either in this scenario.
  decodingInfo.mockImplementation(() =>
    Promise.resolve({ supported: false, powerEfficient: false, smooth: false, keySystemAccess: null }),
  );
  stubMediaCapabilities();

  const { mediaCapabilitiesManager } = await import('./media-capabilities-manager.svelte');

  const levels = [
    { videoCodec: 'avc1.64001e', width: 854, height: 480, bitrate: 2_500_000, frameRate: 60 },
    { videoCodec: 'avc1.64001f', width: 1280, height: 720, bitrate: 5_000_000, frameRate: 60 },
  ];
  const keep = await mediaCapabilitiesManager.efficientLevels(levels);

  // Removing every level would leave hls.js nothing to play at all and go silently blank; keeping
  // them lets a real playback error surface instead (FL-203).
  expect(keep).toEqual(new Set([0, 1]));
});

it('falls back to the safe default when the API is unavailable or throws', async () => {
  const { DEFAULT_DECODING_INFO, mediaCapabilitiesManager } = await import('./media-capabilities-manager.svelte');

  // No navigator.mediaCapabilities stub installed in this test: init() must not throw.
  const info = await mediaCapabilitiesManager.decodingInfo({
    videoCodec: 'avc1.64001e',
    width: 854,
    height: 480,
    bitrate: 2_500_000,
    frameRate: 60,
  });

  expect(info).toEqual(DEFAULT_DECODING_INFO);
});
