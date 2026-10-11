import type { StudioSourceResolutionDto, StudioSourceResolutionRequestDto } from '@frameleaf/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, webcrypto } from 'node:crypto';
import { createStudioSourceResolution, studioSourceJson, type StudioSourceAuthority } from './source-resolution';

const parent = {
  kind: 'project-import',
  id: '11111111-1111-4111-8111-111111111111',
  checksum: 'a'.repeat(64),
} as StudioSourceResolutionRequestDto['parent'];
const request: StudioSourceResolutionRequestDto = { revision: 3, graphDigest: 'b'.repeat(64), parent, selection: {} };
const scope = { userId: 'owner', projectId: 'project', graphVersion: 2 };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const authority = (): StudioSourceAuthority => ({
  userId: 'owner',
  sourceEpoch: 1,
  generation: 1,
  online: true,
  eligible: true,
  project: {
    id: 'project',
    name: 'Saved',
    revision: 3,
    graphDigest: request.graphDigest,
    graphVersion: 2,
    hasLease: true,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(10_000).toISOString(),
    graph: { saved: true },
  },
});
const response = (): StudioSourceResolutionDto => {
  const bytes = '{"v":"5.7","layers":[]}';
  const result = {
    projectId: 'project',
    ...request,
    expiresAt: new Date(5000).toISOString(),
    archive: false,
    files: [{ path: 'animation.json', sha256: sha(bytes), base64: Buffer.from(bytes).toString('base64') }],
  };
  return {
    ...result,
    manifestDigest: sha(
      studioSourceJson({ ...result, files: result.files.map(({ path, sha256 }) => ({ path, sha256 })) }),
    ),
  };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('canonical saved source authority at every asynchronous boundary', () => {
  it('calls only with the acknowledged envelope and exact supplied origin', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const resolve = vi.fn(async () => response());
    const run = createStudioSourceResolution({
      authority,
      resolve,
      signal: new AbortController().signal,
      now: () => 1000,
    });
    expect(await run(request, scope)).toEqual(response());
    expect(resolve).toHaveBeenCalledWith('project', request, expect.any(AbortSignal));
    await expect(run({ ...request, graphDigest: 'c'.repeat(64) }, scope)).rejects.toThrow('REFUSED');
    await expect(run(request, { ...scope, userId: 'other' })).rejects.toThrow('REFUSED');
    expect(resolve).toHaveBeenCalledTimes(1);
  });
  const changes: Record<string, (live: StudioSourceAuthority) => void> = {
    account: (live) => {
      live.userId = 'other';
    },
    project: (live) => {
      live.project.id = 'other';
    },
    revision: (live) => {
      live.project.revision += 1;
    },
    digest: (live) => {
      live.project.graphDigest = 'c'.repeat(64);
    },
    graphVersion: (live) => {
      live.project.graphVersion = 4;
    },
    leaseEpoch: (live) => {
      live.project.leaseEpoch += 1;
    },
    leaseLoss: (live) => {
      live.project.hasLease = false;
    },
    leaseReplacement: (live) => {
      live.project.leaseExpiresAt = new Date(11_000).toISOString();
    },
    offline: (live) => {
      live.online = false;
    },
    declaration: (live) => {
      live.sourceEpoch += 1;
    },
    remount: (live) => {
      live.generation += 1;
    },
    unresolvedSave: (live) => {
      live.eligible = false;
    },
  };
  for (const [name, change] of Object.entries(changes)) {
    for (const boundary of [0, 1, 2]) {
      it(`${name} at ${boundary === 0 ? 'SDK completion' : boundary === 1 ? 'manifest digest' : 'file digest'} publishes zero bytes`, async () => {
        const live = authority();
        let digests = 0;
        let published = 0;
        vi.stubGlobal('crypto', {
          subtle: {
            digest: async (...args: Parameters<SubtleCrypto['digest']>) => {
              const result = await webcrypto.subtle.digest(
                args[0],
                args[1] as Parameters<typeof webcrypto.subtle.digest>[1],
              );
              if (++digests === boundary) change(live);
              return result;
            },
          },
        });
        const run = createStudioSourceResolution({
          authority: () => live,
          signal: new AbortController().signal,
          now: () => 1000,
          resolve: async () => {
            await Promise.resolve();
            if (boundary === 0) change(live);
            return response();
          },
        });
        await expect(
          run(request, scope).then((value) => {
            published += value.files.length;
          }),
        ).rejects.toThrow('REFUSED');
        expect(published).toBe(0);
      });
    }
  }
  for (const boundary of [0, 1, 2]) {
    it(`final expiry without any epoch event at boundary ${boundary} refuses publication`, async () => {
      let time = 1000;
      let digests = 0;
      vi.stubGlobal('crypto', {
        subtle: {
          digest: async (...args: Parameters<SubtleCrypto['digest']>) => {
            const result = await webcrypto.subtle.digest(
              args[0],
              args[1] as Parameters<typeof webcrypto.subtle.digest>[1],
            );
            if (++digests === boundary) time = 10_001;
            return result;
          },
        },
      });
      const run = createStudioSourceResolution({
        authority,
        signal: new AbortController().signal,
        now: () => time,
        resolve: async () => {
          if (boundary === 0) time = 10_001;
          return response();
        },
      });
      await expect(run(request, scope)).rejects.toThrow('REFUSED');
    });
  }
  it('withdraws on disposal while the SDK owns the pending reply', async () => {
    const abort = new AbortController();
    const run = createStudioSourceResolution({
      authority,
      signal: abort.signal,
      now: () => 1000,
      resolve: async () => {
        abort.abort();
        return response();
      },
    });
    await expect(run(request, scope)).rejects.toThrow();
  });
});
