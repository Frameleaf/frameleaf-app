import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CloudMlGateway, CloudUploadedPart } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import type { LoggingRepository } from 'src/repositories/logging.repository.js';
import { CloudTransferError, FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import {
  CLOUD_UPLOAD_PART_BYTES,
  type CloudEstimateRequest,
  type CloudJobCreateRequest,
  type CloudJobView,
  FrameleafCloudError,
} from 'src/utils/frameleaf-cloud.js';

export type LifecycleCase =
  | 'idempotent-create'
  | 'multipart-resume'
  | 'input-sha256-mismatch'
  | 'expired-upload-refresh'
  | 'retry-after'
  | 'output-sha256'
  | 'cancel-release'
  | 'ack-purge';
type RecordedFault = 'premature-retry' | 'double-capture' | 'residual-object';
export type LifecycleFault = RecordedFault | 'corrupt-output' | 'repeated-part-1-prefix';
type Request = { method: 'GET' | 'POST' | 'DELETE'; path: string; headers: Record<string, string>; body?: unknown };
type Response = { status: number; headers: Record<string, string>; body: unknown };
type TransferRequest = {
  method: 'GET' | 'PUT' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array | string;
};
type TransferResponse = { status: number; headers: Record<string, string>; body: Uint8Array };
type Observation = {
  http: Array<{ name: string; receivedAtMs: number; request: Request; response: Response }>;
  storage: Array<{ name: string; receivedAtMs: number; request: TransferRequest; response: TransferResponse }>;
  holds: Array<{ status: 'open' | 'captured' | 'released'; amountMicros: number; minimumMicros: number }>;
  entries: Array<{ kind: string; amountMicros: number; heldDeltaMicros: number }>;
  objects: string[];
};
type RecordedServer = {
  request(name: string, request: Request): Response;
  transfer(name: string, request: TransferRequest): TransferResponse;
  advance(ms: number): void;
  rateLimit(seconds?: number): void;
  finish(outcome: 'completed' | 'input-sha256-mismatch'): void;
  snapshot(): Observation;
};

// Structural boundary for the pending additive API; no copy of the shared runner or verdict logic.
export interface LifecycleTestingApi {
  fixture(path: string): unknown;
  createRecordedMlLifecycleServer(options: {
    storageOrigin: string;
    fault?: RecordedFault;
    now?: () => number;
  }): RecordedServer;
  runMlLifecycleCases(
    adapter: { run(caseId: LifecycleCase): Promise<Observation> },
    assert: undefined,
    cases: readonly LifecycleCase[],
  ): Promise<Array<{ case: string; message: string }>>;
}

export async function loadLifecycleTestingApi(): Promise<LifecycleTestingApi> {
  const modulePath = process.env.FRAMELEAF_CLOUD_LIFECYCLE_TEST_MODULE;
  if (!modulePath || !isAbsolute(modulePath)) {
    throw new Error('FRAMELEAF_CLOUD_LIFECYCLE_TEST_MODULE must name an absolute compiled package testing entrypoint');
  }
  try {
    await access(modulePath);
    const api = await import(/* @vite-ignore */ pathToFileURL(modulePath).href);
    for (const name of ['fixture', 'createRecordedMlLifecycleServer', 'runMlLifecycleCases']) {
      if (typeof api[name] !== 'function') throw new Error('Missing API');
    }
    return api as LifecycleTestingApi;
  } catch {
    throw new Error(
      'Required compiled Cloud lifecycle testing API is missing or incompatible; build the source package',
    );
  }
}

export class LibraryMlLifecycleAdapter {
  corruptOutputRefusedAndRemoved = false;
  constructor(
    private api: LifecycleTestingApi,
    private fault?: LifecycleFault,
  ) {}
  async run(caseId: LifecycleCase): Promise<Observation> {
    this.corruptOutputRefusedAndRemoved = false;
    let name = 'admit';
    let handlerFailed = false;
    let nowMs = Date.parse('2026-09-26T04:01:00Z');
    const wireTransfers: Observation['storage'] = [];
    const advance = (ms: number) => {
      if (this.fault !== 'premature-retry') nowMs += ms;
    };
    const handle = async (request: IncomingMessage, response: ServerResponse) => {
      try {
        const receivedAtMs = nowMs;
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of request) {
          length += chunk.length;
          if (length > CLOUD_UPLOAD_PART_BYTES + 64 * 1024) throw new Error('Fixture request too large');
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const headers = Object.fromEntries(
          Object.entries(request.headers).map(([key, value]) => [
            key,
            Array.isArray(value) ? value.join(', ') : (value ?? ''),
          ]),
        );
        const path = request.url ?? '/';
        if (path.startsWith('/v2/')) {
          const result = recorded.request(name, {
            method: request.method as Request['method'],
            path,
            headers,
            ...(bytes.length > 0 && { body: JSON.parse(bytes.toString()) }),
          });
          response.writeHead(result.status, { 'content-type': 'application/json', ...result.headers });
          response.end(result.body === null ? undefined : JSON.stringify(result.body));
        } else {
          // The recorded storage consumes decoded XML ETag text, as an S3 XML parser does.
          const body = request.method === 'POST' ? bytes.toString().replaceAll('&quot;', '"') : bytes;
          const transferRequest: TransferRequest = {
            method: request.method as TransferRequest['method'],
            url: `${origin}${path}`,
            headers,
            ...(request.method !== 'GET' && { body }),
          };
          const result = recorded.transfer(name, transferRequest);
          const delivered = Buffer.from(result.body);
          // Inject after the healthy recorded store answers, before recording or sending the HTTP body.
          if (this.fault === 'corrupt-output' && name.startsWith('output-') && result.status === 200) {
            if (delivered.length === 0) throw new Error('Output corruption needs nonempty bytes');
            delivered[0] ^= 1;
          }
          wireTransfers.push(
            structuredClone({
              name,
              receivedAtMs,
              request: transferRequest,
              response: { status: result.status, headers: result.headers, body: delivered },
            }),
          );
          response.writeHead(result.status, result.headers);
          response.end(delivered);
        }
      } catch {
        handlerFailed = true;
        response.writeHead(500).end();
      }
    };
    const server = createServer((request, response) => {
      void handle(request, response);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const recorded = this.api.createRecordedMlLifecycleServer({
      storageOrigin: origin,
      fault: this.fault === 'corrupt-output' || this.fault === 'repeated-part-1-prefix' ? undefined : this.fault,
      now: () => nowMs,
    });
    const folder = await mkdtemp(join(tmpdir(), 'library-ml-lifecycle-'));
    try {
      const logger = {
        setContext: () => {},
        warn: () => {},
        log: () => {},
        debug: () => {},
      } as unknown as LoggingRepository;
      const sut = new FrameleafCloudMlRepository(new FrameleafCloudRepository(logger));
      const gateway = {
        url: origin,
        token: {
          signer: {
            kid: 'fixture',
            publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'fixture' },
            sign: () => 'fixture-proof',
          },
          accessToken: 'fixture-token',
        },
      } as CloudMlGateway;
      const action = async <T>(observationName: string, send: () => Promise<T>): Promise<T> => {
        name = observationName;
        const result = await send();
        if (handlerFailed) throw new Error('Recorded lifecycle HTTP handler failed');
        return result;
      };
      const refusal = async (send: () => Promise<unknown>, accepted: (error: unknown) => boolean) => {
        try {
          await send();
        } catch (error) {
          if (accepted(error) && !handlerFailed) return error;
          // eslint-disable-next-line preserve-caught-error -- Transport causes can expose signed URLs and credentials.
          throw new Error('Unexpected lifecycle refusal');
        }
        throw new Error('Expected lifecycle refusal was not received');
      };
      const data = Buffer.alloc(caseId === 'multipart-resume' ? CLOUD_UPLOAD_PART_BYTES + 5 : 32, 7);
      if (caseId === 'multipart-resume') data.set([17, 34, 51, 68, 85], CLOUD_UPLOAD_PART_BYTES);
      const file = join(folder, 'input.jpg');
      await writeFile(file, caseId === 'input-sha256-mismatch' ? Buffer.alloc(data.length, 8) : data);
      const body = this.api.fixture('ml/job-request.json') as CloudJobCreateRequest;
      body.inputs = [{ inputId: 'a1', contentType: 'image/jpeg', bytes: data.length, sha256: digest(data) }];
      const admitted = await action('admit', () => sut.createJob(gateway, body, 'library-lifecycle-fixture-key'));
      const target = admitted.uploads?.[0];
      if (!target) throw new Error('Admission lacks an upload target');
      const read = async (observationName: string): Promise<CloudJobView> => {
        const answer = await action(observationName, () => sut.getJobView(gateway, admitted.jobId, null));
        if (answer.notModified) throw new Error('Unexpected conditional response');
        return answer.data;
      };
      const upload = (observationName = 'input') =>
        action(observationName, () => sut.uploadInput(gateway, target, file));
      const start = () => action('start', () => sut.startJob(gateway, admitted.jobId));

      switch (caseId) {
        case 'idempotent-create': {
          await action('replay', () => sut.createJob(gateway, body, 'library-lifecycle-fixture-key'));
          await refusal(
            () =>
              action('conflict', () =>
                sut.createJob(gateway, { ...body, clientRef: 'changed' }, 'library-lifecycle-fixture-key'),
              ),
            (error) => error instanceof FrameleafCloudError && error.status === 422,
          );
          break;
        }
        case 'multipart-resume': {
          if (!target.multipart) throw new Error('Expected multipart upload');
          const done: CloudUploadedPart[] = [];
          await refusal(
            () =>
              action('part-1', () =>
                sut.uploadInput(
                  gateway,
                  {
                    ...target,
                    multipart: { ...target.multipart!, parts: target.multipart!.parts.slice(0, 1) },
                  },
                  file,
                  {
                    onPart: (part) => {
                      done.push(part);
                      name = 'complete-failed';
                      return Promise.resolve(true);
                    },
                  },
                ),
              ),
            (error) => error instanceof CloudTransferError && error.failure === 'storage-refused',
          );
          await action('resume', () => sut.getUploads(gateway, admitted.jobId));
          const fresh = await action('refresh', () => sut.refreshUpload(gateway, admitted.jobId, target.inputId));
          if (this.fault === 'repeated-part-1-prefix') {
            // A real same-sized resumed file reproduces the bytes an offset-zero read would send.
            await writeFile(file, Buffer.concat([data.subarray(0, CLOUD_UPLOAD_PART_BYTES), data.subarray(0, 5)]));
          }
          await action('part-2', () =>
            sut.uploadInput(gateway, fresh, file, {
              done,
              onPart: () => {
                name = 'complete';
                return Promise.resolve(true);
              },
            }),
          );
          await start();
          await read('final');
          break;
        }
        case 'expired-upload-refresh': {
          advance(900_001);
          await refusal(
            () => upload('expired'),
            (error) => error instanceof CloudTransferError && error.failure === 'target-expired',
          );
          const fresh = await action('refresh', () => sut.refreshUpload(gateway, admitted.jobId, target.inputId));
          await action('refreshed', () => sut.uploadInput(gateway, fresh, file));
          break;
        }
        case 'retry-after': {
          await upload();
          await start();
          recorded.rateLimit(2);
          const estimate = this.api.fixture('ml/estimate-request.json') as CloudEstimateRequest;
          estimate.inputs = body.inputs;
          const limited = (await refusal(
            () => action('limited', () => sut.createEstimate(gateway, estimate)),
            (error) => error instanceof FrameleafCloudError && error.status === 429,
          )) as FrameleafCloudError;
          if (!limited.retryAfterSeconds) throw new Error('Missing Retry-After');
          // Fixture clock orchestration only; production requeue scheduling is not driven here.
          advance(limited.retryAfterSeconds * 1000);
          try {
            await action('retry', () => sut.createEstimate(gateway, estimate));
          } catch (error) {
            if (!(this.fault === 'premature-retry' && error instanceof FrameleafCloudError && error.status === 429))
              throw error;
          }
          const waiting = await action('waiting', () => sut.getJobView(gateway, admitted.jobId, null));
          if (!waiting.retryAfterSeconds) throw new Error('Missing poll Retry-After');
          advance(waiting.retryAfterSeconds * 1000);
          await read('poll');
          break;
        }
        case 'cancel-release': {
          await action('cancel', () => sut.cancelJob(gateway, admitted.jobId));
          await action('cancel-replay', () => sut.cancelJob(gateway, admitted.jobId));
          await read('final');
          break;
        }
        default: {
          await upload();
          await start();
          recorded.finish(caseId === 'input-sha256-mismatch' ? caseId : 'completed');
          // Repeated terminal reads traverse the client without introducing another settlement.
          const final = await read('final');
          await read('terminal-replay');
          if (caseId === 'input-sha256-mismatch') break;
          if (!final.result?.outputs.length) throw new Error('Missing completed outputs');
          for (const output of final.result.outputs) {
            const destination = join(folder, `output-${output.outputId}.json`);
            try {
              await action(`output-${output.outputId}`, () =>
                sut.downloadOutput(gateway, output, final.result!.headers, destination),
              );
              const saved = await readFile(destination);
              if (saved.length !== output.bytes || digest(saved) !== output.sha256)
                throw new Error('Saved output did not verify');
            } catch (error) {
              if (
                this.fault !== 'corrupt-output' ||
                !(error instanceof CloudTransferError) ||
                error.failure !== 'sha256-mismatch'
              )
                throw error;
              const exists = await stat(destination)
                .then(() => true)
                .catch((error_: NodeJS.ErrnoException) => {
                  if (error_.code !== 'ENOENT') throw error_;
                  return false;
                });
              if (exists) {
                // eslint-disable-next-line preserve-caught-error -- Preserve only the fixed failure, never the transfer cause.
                throw new Error('Corrupt output remains');
              }
              this.corruptOutputRefusedAndRemoved = true;
            }
          }
          if (caseId === 'ack-purge') {
            await action('ack', () => sut.deleteJob(gateway, admitted.jobId));
            await action('ack-replay', () => sut.deleteJob(gateway, admitted.jobId));
            await read('purged');
            await refusal(
              () =>
                action('old-output', () =>
                  sut.downloadOutput(
                    gateway,
                    final.result!.outputs[0],
                    final.result!.headers,
                    join(folder, 'old.json'),
                  ),
                ),
              (error) =>
                error instanceof CloudTransferError && error.failure === 'storage-refused' && error.status === 404,
            );
          }
        }
      }
      // Cloud owns HTTP/control observations; the HTTP bridge owns the storage bytes it actually sent.
      // Read the Cloud snapshot unchanged, after wire observations have already been captured.
      const snapshot = recorded.snapshot();
      return {
        http: snapshot.http,
        storage: wireTransfers,
        holds: snapshot.holds,
        entries: snapshot.entries,
        objects: snapshot.objects,
      };
    } catch {
      // Never surface transport exceptions, signed URLs, headers or tokens to test reporters.
      throw new Error(`Library lifecycle action unavailable: ${caseId} (${name})`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(new Error('Local lifecycle server cleanup failed')) : resolve())),
      );
      await rm(folder, { recursive: true, force: true });
    }
  }
}

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
