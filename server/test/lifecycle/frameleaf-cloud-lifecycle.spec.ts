import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { cloudMlJobBackoffMs } from 'src/utils/cloud-ml-job.js';
import { LibraryMlLifecycleAdapter, loadLifecycleTestingApi } from 'test/fixtures/frameleaf-cloud-lifecycle-adapter.js';

describe('Library ML lifecycle source candidate', () => {
  let api: Awaited<ReturnType<typeof loadLifecycleTestingApi>>;
  beforeAll(async () => {
    api = await loadLifecycleTestingApi();
  });

  it.each([
    'idempotent-create',
    'multipart-resume',
    'input-sha256-mismatch',
    'expired-upload-refresh',
    'retry-after',
    'output-sha256',
    'cancel-release',
    'ack-purge',
  ] as const)('qualifies %s over actual repository HTTP and files', async (caseId) => {
    expect(await api.runMlLifecycleCases(new LibraryMlLifecycleAdapter(api), undefined, [caseId])).toEqual([]);
  });

  it.each([
    ['premature-retry', 'retry-after'],
    ['double-capture', 'output-sha256'],
    ['residual-object', 'ack-purge'],
  ] as const)('shared runner rejects fixture fault %s', async (fault, caseId) => {
    const failures = await api.runMlLifecycleCases(new LibraryMlLifecycleAdapter(api, fault), undefined, [caseId]);
    expect(failures.map((failure) => failure.case)).toContain(caseId);
    expect(failures.some((failure) => failure.message.includes('missing, invalid, or unavailable'))).toBe(false);
  });

  it('refuses same-length corrupt output by digest and removes its destination', async () => {
    const adapter = new LibraryMlLifecycleAdapter(api, 'corrupt-output');
    const observation = await adapter.run('output-sha256');
    const final = observation.http.find((exchange) => exchange.name === 'final')!.response.body as {
      result: { outputs: Array<{ outputId: string; bytes: number; sha256: string }> };
    };
    const declared = final.result.outputs[0];
    const delivered = observation.storage.find((transfer) => transfer.name === `output-${declared.outputId}`)!;
    // Assert only scalars: an observation dump can disclose signed URLs and storage headers.
    expect(delivered.response.status).toBe(200);
    expect(delivered.response.body.byteLength).toBe(declared.bytes);
    expect(createHash('sha256').update(delivered.response.body).digest('hex')).not.toBe(declared.sha256);
    const failures = await api.runMlLifecycleCases({ run: () => Promise.resolve(observation) }, undefined, [
      'output-sha256',
    ]);
    expect(adapter.corruptOutputRefusedAndRemoved).toBe(true);
    expect(failures.some((failure) => failure.message.includes('SHA-256'))).toBe(true);
  });

  it('multipart input has distinct ranges so reading part 2 at offset zero changes its digest', async () => {
    const observation = await new LibraryMlLifecycleAdapter(api).run('multipart-resume');
    const first = observation.storage.find((transfer) => transfer.name === 'part-1')!.request.body as Uint8Array;
    const second = observation.storage.find((transfer) => transfer.name === 'part-2')!.request.body as Uint8Array;
    expect([...first.subarray(0, 5)]).toEqual([7, 7, 7, 7, 7]);
    expect([...second]).toEqual([17, 34, 51, 68, 85]);
  });

  it('shared runner rejects a resumed file whose second range repeats the first range prefix', async () => {
    const failures = await api.runMlLifecycleCases(
      new LibraryMlLifecycleAdapter(api, 'repeated-part-1-prefix'),
      undefined,
      ['multipart-resume'],
    );
    expect(failures.some((failure) => failure.message.includes('declared input digest'))).toBe(true);
    expect(failures.some((failure) => failure.message.includes('missing, invalid, or unavailable'))).toBe(false);
  });

  it('keeps production backoff at least Retry-After within its documented 15-minute ceiling', () => {
    expect(cloudMlJobBackoffMs(1, 7)).toBe(7000);
    expect(cloudMlJobBackoffMs(1, 60)).toBe(60_000);
    expect(cloudMlJobBackoffMs(1, 1200)).toBe(900_000);
  });
});
