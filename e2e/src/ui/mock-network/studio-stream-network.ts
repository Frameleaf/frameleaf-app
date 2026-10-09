import type { BrowserContext, Page } from '@playwright/test';
import { workerDouble } from 'src/ui/mock-network/studio-stream-worker-double.js';

/**
 * A mocked server for Studio's streamed playback (FL-96): one saved project at revision 3 the
 * account owns, a live render worker, the exact-frame preview routes, and the preview stream
 * signalling routes as a small state machine that relays the in-page worker double's offer and the
 * browser's answer (`studio-stream-worker-double.ts`).
 *
 * The editor is a stand-in document speaking the real frame protocol (hello, mount, `mounted` with
 * what it can decode locally, `transport` and `service` messages), so the host, its bridge, its
 * stream client and its panel are the production code; only the React editor is absent. The real
 * editor's transport reporting is `watchTransport` in `studio/adapters/web/src/editor-frame.tsx`.
 */
export const STUDIO_PROJECT_ID = '0195e2a0-0000-7000-8000-0000000000f1';
/** `pinnedFreecutRevision` in `web/src/lib/frameleaf/studio/engine-loader.ts`. */
const ENGINE_REVISION = '4d62e8082c5eb387a96275bcbd323d28f6e41a62';
// The e2e TS root cannot import the web package; ui-fixture-contracts.spec.mjs checks this against the host.
const FRAME_PROTOCOL = 6;

export type StreamSessionState = 'queued' | 'negotiating' | 'offered' | 'answered' | 'closed';

export type StudioStreamMock = {
  revision: number;
  /** What the stand-in editor reports it can decode locally. */
  webCodecs: boolean;
  /** Whether the stand-in editor reports WebGPU (without it, its own picture leaves out GPU effects). */
  webGpu: boolean;
  requests: string[];
  sessions: Array<{
    id: string;
    state: StreamSessionState;
    closeReason: string | null;
    negotiation: number;
    offer: string | null;
    answer: string | null;
    start: { numerator: string; denominator: string };
  }>;
  /** Refuse the next reconnect with this code (a failed validation). */
  refuseReconnect: string | null;
};

// One tiny opaque PNG, the exact frame the server "rendered".
const FRAME_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const editorDocument = `<!doctype html><html><body><script>
  const params = new URLSearchParams(location.search);
  let port = null;
  let callId = 0;
  const post = (message) => port && port.postMessage(message);
  window.__editor = {
    context: null,
    transport(playing, num, den, seek) { post({ type: 'transport', playing, time: { num, den }, seek }); },
    requestFrame(num, den) {
      post({
        type: 'service',
        callId: ++callId,
        name: 'submitCommands',
        args: [[{
          id: 'preview.request',
          payload: { at: { num, den }, quality: 'standard', viewportWidth: 640, viewportHeight: 360 },
          revision: window.__editor.context.project.revision,
          idempotencyKey: crypto.randomUUID(),
          issuedAt: Date.now(),
        }]],
      });
    },
  };
  addEventListener('message', (event) => {
    if (event.data && event.data.source === 'frameleaf-studio-host' && event.ports[0]) {
      port = event.ports[0];
      port.onmessage = ({ data }) => {
        if (data.type === 'mount') {
          window.__editor.context = data.context;
          post({ type: 'mounted', support: { webCodecs: params.get('webcodecs') !== '0', webGpu: params.get('webgpu') !== '0' } });
        } else if (data.type === 'update') {
          window.__editor.context = data.context;
        } else if (data.type === 'dispose') {
          post({ type: 'disposed' });
        }
      };
    }
  });
  parent.postMessage({ source: 'frameleaf-studio-frame', kind: 'editor', protocolVersion: ${FRAME_PROTOCOL}, engineRevision: '${ENGINE_REVISION}' }, location.origin);
</script></body></html>`;

const iso = () => new Date().toISOString();

const sessionDto = (mock: StudioStreamMock, session: StudioStreamMock['sessions'][number]) => ({
  id: session.id,
  projectId: STUDIO_PROJECT_ID,
  revision: mock.revision,
  state: session.state,
  closeReason: session.closeReason,
  currentRevision: null,
  negotiation: session.negotiation,
  offer: session.state === 'offered' ? session.offer : null,
  start: session.start,
  bounds: { maxBitrateKbps: 6000, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30, maxDurationSeconds: 1800 },
  keepaliveMs: 5000,
  expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
});

export const setupStudioStreamMocks = async (context: BrowserContext, page: Page, mock: StudioStreamMock) => {
  const worker = workerDouble(page);

  /** The worker holding the session offers for its current round, as a real one would on its next poll. */
  const offerFor = (session: StudioStreamMock['sessions'][number]) => {
    const round = session.negotiation;
    void worker.offer().then((sdp) => {
      if (session.state === 'closed' || session.negotiation !== round) {
        return;
      }
      session.offer = sdp;
      session.state = 'offered';
    });
  };

  await context.route('**/studio-engine/manifest.json', (route) =>
    route.fulfill({
      json: {
        protocolVersion: FRAME_PROTOCOL,
        engineRevision: ENGINE_REVISION,
        sourceSha256: 'e2e',
        features: [],
        editor: `editor.html?webcodecs=${mock.webCodecs ? '1' : '0'}&webgpu=${mock.webGpu ? '1' : '0'}`,
        commands: 'commands.html',
      },
    }),
  );
  await context.route('**/studio-engine/editor.html*', (route) =>
    route.fulfill({ contentType: 'text/html', body: editorDocument }),
  );

  await context.route('**/api/ml-destinations/capabilities', (route) =>
    route.fulfill({
      json: {
        probedAt: iso(),
        workloads: [],
        studio: {
          gpuWorker: true,
          renderWorker: true,
          restorationWorker: false,
          transcriptionWorker: false,
          render: [],
        },
      },
    }),
  );

  await context.route(`**/api/studio/projects/${STUDIO_PROJECT_ID}`, (route) =>
    route.fulfill({
      json: {
        id: STUDIO_PROJECT_ID,
        name: 'Summer film',
        ownerId: 'owner',
        access: 'owner',
        shelf: 'active',
        revision: mock.revision,
        digest: 'digest',
        envelope: { engine: 'freecut', engineRevision: ENGINE_REVISION, schemaVersion: 1, graph: {} },
        resources: null,
        lease: {
          heldByYou: true,
          heldByAnother: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          leaseMs: 60_000,
          renewMs: 20_000,
          autosaveDebounceMs: 2000,
        },
        withheld: false,
        spaceId: null,
        archivedAt: null,
        deletedAt: null,
        purgeAfter: null,
        duplicatedFromId: null,
        importedFromBundle: false,
        lastOpenedAt: iso(),
        thumbnailAssetId: null,
        createdAt: iso(),
        updatedAt: iso(),
      },
    }),
  );
  await context.route(`**/api/studio/projects/${STUDIO_PROJECT_ID}/lease*`, (route) =>
    route.fulfill({
      json: {
        heldByYou: true,
        heldByAnother: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        leaseMs: 60_000,
        renewMs: 20_000,
        autosaveDebounceMs: 2000,
      },
    }),
  );
  await context.route(`**/api/studio/projects/${STUDIO_PROJECT_ID}/comments*`, (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await context.route('**/api/studio/workspace', (route) =>
    route.fulfill({ json: { engineRevision: null, layout: null, savedAt: null } }),
  );

  // The exact-frame path (FL-96's merged foundation): every request is ready at once.
  await context.route('**/api/studio/previews', (route) => {
    const body = route.request().postDataJSON() as { time: { numerator: string; denominator: string } };
    mock.requests.push(`preview ${body.time.numerator}/${body.time.denominator}`);
    return route.fulfill({
      json: {
        preview: {
          id: '0195e2a0-0000-7000-8000-00000000aa01',
          projectId: STUDIO_PROJECT_ID,
          revision: mock.revision,
          revisionDigest: 'digest',
          time: body.time,
          quality: 'standard',
          viewportWidth: 640,
          viewportHeight: 360,
          status: 'ready',
          operationId: null,
          seekGeneration: '1',
          etag: '"frame"',
          framePts: '0',
          framePtsTimebase: '1/90000',
          sizeInBytes: String(FRAME_PNG.length),
          contentType: 'image/png',
          toneMapped: false,
          errorCode: null,
          requestedAt: iso(),
          readyAt: iso(),
          expiresAt: null,
        },
        currentRevision: mock.revision,
        supersededPreviewIds: [],
      },
    });
  });
  await context.route('**/api/studio/previews/*/frame', (route) =>
    route.fulfill({ contentType: 'image/png', headers: { etag: '"frame"' }, body: FRAME_PNG }),
  );

  // Streamed playback signalling.
  await context.route('**/api/studio/preview-streams', (route) => {
    const body = route.request().postDataJSON() as { time: { numerator: string; denominator: string } };
    const session = {
      id: `0195e2a0-0000-7000-8000-${String(mock.sessions.length + 1).padStart(12, '0')}`,
      state: 'queued' as StreamSessionState,
      closeReason: null,
      negotiation: 0,
      offer: null,
      answer: null,
      start: body.time,
    };
    mock.sessions.push(session);
    mock.requests.push(`open ${body.time.numerator}/${body.time.denominator}`);
    session.state = 'negotiating';
    offerFor(session);
    return route.fulfill({ status: 201, json: sessionDto(mock, session) });
  });
  await context.route('**/api/studio/preview-streams/**', async (route) => {
    const request = route.request();
    const session = mock.sessions.find((candidate) => request.url().includes(candidate.id));
    if (!session) {
      return route.fulfill({ status: 404, json: { message: 'Preview stream not found' } });
    }
    const path = new URL(request.url()).pathname;
    if (request.method() === 'DELETE') {
      mock.requests.push('close');
      if (session.state !== 'closed') {
        session.state = 'closed';
        session.closeReason = 'closed';
      }
      return route.fulfill({ json: sessionDto(mock, session) });
    }
    if (path.endsWith('/answer')) {
      const body = request.postDataJSON() as { negotiation: number; sdp: string };
      mock.requests.push(`answer ${body.negotiation}`);
      session.answer = body.sdp;
      session.state = 'answered';
      await worker.answer(body.sdp);
      return route.fulfill({ json: sessionDto(mock, session) });
    }
    if (path.endsWith('/reconnect')) {
      mock.requests.push('reconnect');
      if (mock.refuseReconnect) {
        session.state = 'closed';
        session.closeReason = 'revoked';
        const code = mock.refuseReconnect;
        mock.refuseReconnect = null;
        return route.fulfill({ status: 409, json: { message: 'refused', code } });
      }
      session.negotiation += 1;
      session.offer = null;
      session.answer = null;
      session.state = 'negotiating';
      offerFor(session);
      return route.fulfill({ json: sessionDto(mock, session) });
    }
    return route.fulfill({ json: sessionDto(mock, session) });
  });
};

/** The stand-in editor inside the Studio frame. */
export const studioEditor = (page: Page) => {
  const frame = () => page.frames().find((candidate) => candidate.url().includes('/studio-engine/editor.html'))!;
  return {
    /** The editor's transport, as `watchTransport` reports it. */
    transport: (playing: boolean, seconds: number, seek = false) =>
      frame().evaluate(([p, n, s]) => (globalThis as any).__editor.transport(p, n, 1, s), [
        playing,
        seconds,
        seek,
      ] as const),
    /** The paused playhead asks the host for the exact frame, as `RemotePreview` does. */
    requestFrame: (seconds: number) =>
      frame().evaluate((n) => (globalThis as any).__editor.requestFrame(n, 1), seconds),
    serverPreviewOpen: () => frame().evaluate(() => (globalThis as any).__editor.context?.serverPreviewOpen),
  };
};
