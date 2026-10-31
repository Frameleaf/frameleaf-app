import { once } from 'node:events';
import { createServer } from 'node:http';
import z from 'zod';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MlAdmissionRefusal } from 'src/enum.js';
import { FrameleafCloudPublicCall, FrameleafCloudRepository } from 'src/repositories/frameleaf-cloud.repository.js';
import { FrameleafCloudError } from 'src/utils/frameleaf-cloud.js';

const request = { url: 'https://cloud.test/discovery', unauthenticated: FrameleafCloudPublicCall.Discovery };
const repository = () => new FrameleafCloudRepository({ setContext: vi.fn(), warn: vi.fn() } as never);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([new TypeError('private transport detail'), new DOMException('private timeout detail', 'TimeoutError')])(
  'normalizes a body failure after headers arrive (%s)',
  async (failure) => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(failure);
      },
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const error = await repository()
      .requestJson(z.unknown(), request)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FrameleafCloudError);
    expect(error).toMatchObject({ refusal: MlAdmissionRefusal.CloudUnavailable, status: null });
    expect(String(error)).not.toContain('private');
  },
);

it('normalizes a real HTTP connection broken after response headers', async () => {
  let outgoing: ServerResponse | undefined;
  const server = createServer((_request, response) => {
    outgoing = response;
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
    response.write('{"value":');
  });
  const nativeFetch = fetch;
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let headersReceived = false;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    const response = await nativeFetch(...args);
    headersReceived = true;
    outgoing!.destroy();
    return response;
  });
  try {
    await expect(
      repository().requestJson(z.unknown(), {
        ...request,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/discovery`,
      }),
    ).rejects.toBeInstanceOf(FrameleafCloudError);
    expect(headersReceived).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('preserves the existing bounded-body refusal and HTTP status', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('oversized body')));
  await expect(repository().requestJson(z.unknown(), { ...request, maxBodyBytes: 1 })).rejects.toMatchObject({
    refusal: MlAdmissionRefusal.CloudUnavailable,
    status: 200,
    message: 'Frameleaf Cloud response is too large',
  });
});
