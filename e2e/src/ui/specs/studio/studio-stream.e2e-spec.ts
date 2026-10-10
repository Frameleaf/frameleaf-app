import { faker } from '@faker-js/faker';
import { expect, test, type Page } from '@playwright/test';
import { setupBaseMockApiRoutes } from 'src/ui/mock-network/base-network.js';
import {
  STUDIO_PROJECT_ID,
  setupStudioStreamMocks,
  studioEditor,
  type StudioStreamMock,
} from 'src/ui/mock-network/studio-stream-network.js';
import { installStudioWorkerDouble, workerDouble } from 'src/ui/mock-network/studio-stream-worker-double.js';

/**
 * Streamed Studio playback (FL-96, `STU-402`) against a mocked server: the host's WebRTC player in
 * the server preview panel, driven by the editor's own transport, with a render worker double on a
 * real loopback peer connection. Play, pause, seek (stale frames discarded), revoke, reconnect after
 * a dropped connection, and the fallback for browsers without WebCodecs or without WebRTC.
 */
test.use({
  // Both peers are in this browser; let host candidates resolve without mDNS.
  launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] },
});

const studioPage = `/studio?project=${STUDIO_PROJECT_ID}`;

const defaults = (overrides: Partial<StudioStreamMock> = {}): StudioStreamMock => ({
  revision: 3,
  webCodecs: true,
  webGpu: true,
  requests: [],
  sessions: [],
  refuseReconnect: null,
  ...overrides,
});

const panel = (page: Page) => page.getByTestId('studio-server-preview');
const video = (page: Page) => page.getByTestId('studio-stream-video');
const status = (page: Page) => page.getByTestId('studio-server-preview-status');

/** Load Studio. The editor mounts on its own once the capability probe reports a render worker. */
const open = async (page: Page, mock: StudioStreamMock) => {
  await page.goto(studioPage);
  if (mock.webCodecs && mock.webGpu) {
    await page.getByTestId('studio-server-preview-show').click();
  }
  await expect(panel(page)).toBeVisible();
  await installStudioWorkerDouble(page, mock.revision);
};

/** The picture is live once the worker reported a frame of the newest seek and the video is playing. */
const expectLive = async (page: Page) => {
  await expect(video(page)).toHaveAttribute('data-live', 'true', { timeout: 20_000 });
  await expect
    .poll(() => video(page).evaluate((element: HTMLVideoElement) => element.videoWidth), { timeout: 20_000 })
    .toBeGreaterThan(0);
};

test.describe('Studio streamed playback', () => {
  let mock: StudioStreamMock;

  test.beforeEach(async ({ context }) => {
    await setupBaseMockApiRoutes(context, faker.string.uuid());
  });

  test('plays, pauses and seeks from the editor transport, discarding stale frames', async ({ context, page }) => {
    mock = defaults();
    await setupStudioStreamMocks(context, page, mock);
    await open(page, mock);
    const editor = studioEditor(page);
    const worker = workerDouble(page);

    await editor.transport(true, 2);
    await expectLive(page);
    expect(mock.requests).toEqual(expect.arrayContaining(['open 2/1', 'answer 0']));
    expect(await worker.intents()).toContainEqual({ type: 'play', seekGeneration: 1, at: '2/1' });

    // Pause: the worker is told, and the picture is no longer presented as live.
    await editor.transport(false, 3);
    await expect(video(page)).toHaveAttribute('data-live', 'false');
    await expect.poll(() => worker.intents()).toContainEqual({ type: 'pause', seekGeneration: 2, at: '3/1' });

    // The paused playhead shows the exact frame the server rendered.
    await editor.requestFrame(3);
    await expect(page.getByTestId('studio-exact-frame')).toBeVisible();

    // Seek while playing, with a slow worker still reporting the previous seek: nothing is shown as
    // current until the worker catches up.
    await editor.transport(true, 3);
    await expectLive(page);
    await worker.hold(3);
    await editor.transport(true, 30, true);
    await expect
      .poll(() => worker.intents())
      .toContainEqual({ type: 'seek', seekGeneration: 4, at: '30/1', playing: true });
    await expect(video(page)).toHaveAttribute('data-live', 'false');
    await expect(panel(page)).toHaveAttribute('data-stream-phase', 'seeking');
    await worker.hold(null);
    await expectLive(page);
  });

  test('stops the picture and never reconnects when access is revoked', async ({ context, page }) => {
    mock = defaults();
    await setupStudioStreamMocks(context, page, mock);
    await open(page, mock);
    await studioEditor(page).transport(true, 0);
    await expectLive(page);

    // The server closes the session as revoked (a source was trashed, relocked or unshared).
    mock.sessions[0].state = 'closed';
    mock.sessions[0].closeReason = 'revoked';

    await expect(status(page)).toHaveText(
      "Playback stopped because you can no longer see some of this project's media.",
      {
        timeout: 10_000,
      },
    );
    await expect(video(page)).toHaveAttribute('data-live', 'false');
    expect(await video(page).evaluate((element: HTMLVideoElement) => element.srcObject)).toBeNull();
    expect(mock.requests).not.toContain('reconnect');
  });

  test('reconnects a dropped connection only through the server check', async ({ context, page }) => {
    mock = defaults();
    await setupStudioStreamMocks(context, page, mock);
    await open(page, mock);
    const worker = workerDouble(page);
    await studioEditor(page).transport(true, 1);
    await expectLive(page);

    await worker.drop();
    await expect
      .poll(() => mock.requests.filter((request) => request === 'reconnect').length, { timeout: 20_000 })
      .toBe(1);
    await expect.poll(() => mock.requests).toContain('answer 1');
    await expectLive(page);
    expect(await worker.offers()).toBe(2);
    // The new connection is told where playback is.
    const intents = await worker.intents();
    expect(intents.at(-1)).toMatchObject({ type: 'play', at: '1/1' });

    // A reconnect the server refuses (a source revoked meanwhile) ends playback instead.
    mock.refuseReconnect = 'studio_preview_sources_refused';
    await worker.drop();
    await expect(status(page)).toHaveText(
      "Playback stopped because you can no longer see some of this project's media.",
      {
        timeout: 20_000,
      },
    );
  });

  test('opens by itself and plays without WebCodecs', async ({ context, page }) => {
    mock = defaults({ webCodecs: false });
    await setupStudioStreamMocks(context, page, mock);
    await open(page, mock);
    await expect.poll(() => studioEditor(page).serverPreviewOpen()).toBe(true);

    await studioEditor(page).transport(true, 5);
    await expectLive(page);
  });

  test('opens by itself and names the missing WebGPU', async ({ context, page }) => {
    mock = defaults({ webGpu: false });
    await setupStudioStreamMocks(context, page, mock);
    await open(page, mock);
    await expect.poll(() => studioEditor(page).serverPreviewOpen()).toBe(true);
    await expect(page.getByTestId('studio-local-preview-without-webgpu')).toHaveText(
      "This browser has no WebGPU, so the editor's own picture leaves out GPU effects. The server preview shows the full picture.",
    );

    // Closing the panel leaves the notice: the editor's own picture is still not the full one.
    await panel(page).getByRole('button', { name: 'Hide' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(page.getByTestId('studio-local-preview-without-webgpu')).toBeVisible();
  });

  test('falls back to exact frames in a browser without WebRTC', async ({ context, page }) => {
    await context.addInitScript(() => {
      delete (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection;
    });
    mock = defaults({ webCodecs: false });
    await setupStudioStreamMocks(context, page, mock);
    await page.goto(studioPage);
    await expect(panel(page)).toBeVisible();
    const editor = studioEditor(page);

    await editor.transport(true, 1);
    await expect(status(page)).toHaveText("This browser can't play from the server. Pause to see exact frames.");
    expect(mock.requests.some((request) => request.startsWith('open'))).toBe(false);

    await editor.transport(false, 4);
    await editor.requestFrame(4);
    await expect(page.getByTestId('studio-exact-frame')).toBeVisible();
    expect(mock.requests).toContain('preview 4/1');
  });
});
