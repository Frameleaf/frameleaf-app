import type { Page } from '@playwright/test';

/**
 * A render worker test double for streamed Studio playback (FL-96).
 *
 * It implements the worker side of the contract in `web/src/lib/frameleaf/studio/preview-stream-protocol.ts`
 * with a real `RTCPeerConnection`, in the page under test (a loopback connection, so no network and
 * no media server): a send-only video track drawn on a canvas, the `fl-control` data channel, the
 * newest-intent-wins rule and a `frame` report for every frame it sends. The e2e suite's mocked
 * server relays its offer and the browser's answer exactly as the real server does, so the host's
 * player, signalling and fallback are exercised end to end. The real worker (GPU encode, the stored
 * revision rendered) is qualified under FL-145.
 *
 * Test controls: `holdGeneration` keeps reporting an older seek (a slow worker), `drop()` loses the
 * connection without saying so (a worker or network failure), and `intents` records what it was told.
 */
export type WorkerDoubleIntent = { type: string; seekGeneration: number; at: string; playing?: boolean };

export const installStudioWorkerDouble = async (page: Page, revision: number) => {
  await page.evaluate((boundRevision) => {
    type Intent = { type: string; seekGeneration: number; at: string; playing?: boolean };
    const state = {
      revision: boundRevision,
      pc: null as RTCPeerConnection | null,
      dc: null as RTCDataChannel | null,
      intents: [] as Intent[],
      generation: 0,
      playing: false,
      holdGeneration: null as number | null,
      pts: 0,
      offers: 0,
      async offer(): Promise<string> {
        state.pc?.close();
        const pc = new RTCPeerConnection({ iceServers: [] });
        state.pc = pc;
        state.offers++;
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext('2d')!;
        const draw = setInterval(() => {
          if (pc.connectionState === 'closed') {
            clearInterval(draw);
            return;
          }
          context.fillStyle = `hsl(${(state.pts / 3000) % 360} 60% 40%)`;
          context.fillRect(0, 0, canvas.width, canvas.height);
          if (state.playing) {
            state.pts += 3000;
          }
        }, 1000 / 30);
        const stream = canvas.captureStream(30);
        pc.addTransceiver(stream.getVideoTracks()[0], { direction: 'sendonly', streams: [stream] });
        const dc = pc.createDataChannel('fl-control');
        state.dc = dc;
        dc.addEventListener('message', (event) => {
          const intent = JSON.parse(event.data as string) as Intent;
          state.intents.push(intent);
          // Newest intent wins; an older one arriving late is ignored.
          if (intent.seekGeneration <= state.generation) {
            return;
          }
          state.generation = intent.seekGeneration;
          state.playing = intent.type === 'play' || (intent.type === 'seek' && intent.playing === true);
          const [num, den] = intent.at.split('/').map(Number);
          state.pts = Math.round((num / den) * 90_000);
          // The first frame of every intent is reported, playing or not.
          state.report();
        });
        const reporter = setInterval(() => {
          if (pc.connectionState === 'closed') {
            clearInterval(reporter);
            return;
          }
          if (state.playing) {
            state.report();
          }
        }, 100);
        await pc.setLocalDescription(await pc.createOffer());
        await new Promise<void>((resolve) => {
          if (pc.iceGatheringState === 'complete') {
            resolve();
            return;
          }
          pc.addEventListener('icegatheringstatechange', () => {
            if (pc.iceGatheringState === 'complete') {
              resolve();
            }
          });
        });
        return pc.localDescription!.sdp;
      },
      async answer(sdp: string) {
        await state.pc!.setRemoteDescription({ type: 'answer', sdp });
      },
      report() {
        if (state.dc?.readyState !== 'open' || state.generation === 0) {
          return;
        }
        state.dc.send(
          JSON.stringify({
            type: 'frame',
            seekGeneration: state.holdGeneration ?? state.generation,
            revision: state.revision,
            pts: String(state.pts),
            timebase: '1/90000',
          }),
        );
      },
      /** The worker vanishes: no close message, no signalling. */
      drop() {
        state.pc?.close();
      },
    };
    Object.defineProperty(globalThis, '__workerDouble', { value: state, configurable: true });
  }, revision);
};

type Double = {
  offer(): Promise<string>;
  answer(sdp: string): Promise<void>;
  drop(): void;
  intents: WorkerDoubleIntent[];
  holdGeneration: number | null;
  offers: number;
};
type WithDouble = { __workerDouble: Double };

// Each callback runs in the page, so it reaches the double through the page's global itself.
export const workerDouble = (page: Page) => ({
  offer: () => page.evaluate(() => (globalThis as unknown as WithDouble).__workerDouble.offer()),
  answer: (sdp: string) =>
    page.evaluate((value) => (globalThis as unknown as WithDouble).__workerDouble.answer(value), sdp),
  drop: () => page.evaluate(() => (globalThis as unknown as WithDouble).__workerDouble.drop()),
  intents: () => page.evaluate(() => (globalThis as unknown as WithDouble).__workerDouble.intents),
  offers: () => page.evaluate(() => (globalThis as unknown as WithDouble).__workerDouble.offers),
  hold: (generation: number | null) =>
    page.evaluate((value) => {
      (globalThis as unknown as WithDouble).__workerDouble.holdGeneration = value;
    }, generation),
});
