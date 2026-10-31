import { cloneDeep } from 'lodash-es';
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaults } from 'src/dtos/config.dto.js';
import { SystemMetadataKey } from 'src/enum.js';
import {
  clearConfigCache,
  getConfig,
  getConfigRevision,
  readConfig,
  updateConfig,
  withEffectiveConfigWrite,
} from 'src/utils/config.js';
import { canonicalJson } from 'src/utils/object.js';
import {
  applyRecoveryMlOverlay,
  recoveryAuthorityDigest,
  recoveryMlConfigOf,
} from 'src/utils/recovery-ml-authority.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getMocks } from 'test/utils.js';

describe('getConfigRevision (FL-66 settings revision)', () => {
  it('is the same for equal settings whatever their key order', () => {
    const reordered = Object.fromEntries(Object.entries(cloneDeep(defaults)).toReversed()) as typeof defaults;
    expect(getConfigRevision(reordered)).toBe(getConfigRevision(defaults));
  });

  it('changes when any saved setting changes', () => {
    const trash = cloneDeep(defaults);
    trash.trash.days = defaults.trash.days + 1;
    const smtp = cloneDeep(defaults);
    smtp.notifications.smtp.transport.password = 'another-password';
    const oauth = cloneDeep(defaults);
    oauth.oauth.clientSecret = 'rotated-secret';

    const revisions = new Set([defaults, trash, smtp, oauth].map((config) => getConfigRevision(config)));
    expect(revisions.size).toBe(4);
  });

  it('never digests write-only secrets, only whether they are set', () => {
    const first = cloneDeep(defaults);
    first.oauth.clientSecret = 'secret_first';
    first.notifications.smtp.transport.password = 'smtp_first';
    const second = cloneDeep(defaults);
    second.oauth.clientSecret = 'secret_second';
    second.notifications.smtp.transport.password = 'smtp_second';

    expect(getConfigRevision(first)).toBe(getConfigRevision(second));
    expect(getConfigRevision(first)).not.toBe(getConfigRevision(defaults));
  });

  it('ignores the re-queue bookkeeping the server writes on its own', () => {
    const deferred = cloneDeep(defaults);
    deferred.machineLearning.imageDescription.pendingRequeueAt = '2026-09-23T10:00:00.000Z';
    deferred.machineLearning.imageDescription.lastConfigChangeAt = '2026-09-22T10:00:00.000Z';

    expect(getConfigRevision(deferred)).toBe(getConfigRevision(defaults));
  });

  it('never changes the config it digests', () => {
    const config = cloneDeep(defaults);
    config.machineLearning.imageDescription.pendingRequeueAt = '2026-09-23T10:00:00.000Z';

    getConfigRevision(config);

    expect(config.machineLearning.imageDescription.pendingRequeueAt).toBe('2026-09-23T10:00:00.000Z');
  });

  it('is short, opaque text', () => {
    expect(getConfigRevision(defaults)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('canonical system configuration storage', () => {
  let mocks: ReturnType<typeof getMocks>;
  let metadata: Map<SystemMetadataKey, unknown>;

  const repos = () => ({
    configRepo: mocks.config as never,
    metadataRepo: mocks.systemMetadata as never,
    logger: mocks.logger as never,
  });

  beforeEach(() => {
    mocks = getMocks();
    metadata = new Map();
    clearConfigCache();
    mocks.systemMetadata.get.mockImplementation((key) => Promise.resolve(cloneDeep(metadata.get(key)) as never));
    mocks.systemMetadata.set.mockImplementation((key, value) => {
      metadata.set(key, cloneDeep(value));
      return Promise.resolve();
    });
  });

  it('discards an in-flight configuration read invalidated before it finishes', async () => {
    const started = Promise.withResolvers<void>();
    const stale = Promise.withResolvers<unknown>();
    let reads = 0;
    mocks.systemMetadata.get.mockImplementation((key) => {
      if (key === SystemMetadataKey.SystemConfig && ++reads === 1) {
        started.resolve();
        return stale.promise as never;
      }
      return Promise.resolve(cloneDeep(metadata.get(key)) as never);
    });
    const pending = getConfig(repos(), { withCache: true });
    await started.promise;
    metadata.set(SystemMetadataKey.SystemConfig, { trash: { days: defaults.trash.days + 2 } });
    clearConfigCache();
    stale.resolve({ trash: { days: defaults.trash.days + 1 } });

    expect((await pending).trash.days).toBe(defaults.trash.days + 2);
    expect((await getConfig(repos(), { withCache: true })).trash.days).toBe(defaults.trash.days + 2);
    expect(reads).toBe(2);
  });

  it('coalesces concurrent forced refreshes even when the clock does not advance', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1234);
    const started = Promise.withResolvers<void>();
    const refresh = Promise.withResolvers<unknown>();
    let reads = 0;
    mocks.systemMetadata.get.mockImplementation((key) => {
      if (key === SystemMetadataKey.SystemConfig && ++reads === 2) {
        started.resolve();
        return refresh.promise as never;
      }
      return Promise.resolve(cloneDeep(metadata.get(key)) as never);
    });
    try {
      await getConfig(repos(), { withCache: true });
      const first = getConfig(repos(), { withCache: false });
      await started.promise;
      const second = getConfig(repos(), { withCache: false });
      await Promise.resolve();
      refresh.resolve({});
      const [a, b] = await Promise.all([first, second]);
      expect(a).toBe(b);
      expect(reads).toBe(2);
    } finally {
      clock.mockRestore();
    }
  });

  it('releases the configuration lock after a read rejects', async () => {
    const failure = new Error('synthetic configuration read failure');
    mocks.systemMetadata.get.mockRejectedValueOnce(failure);
    await expect(getConfig(repos(), { withCache: false })).rejects.toBe(failure);
    expect(await getConfig(repos(), { withCache: true })).toEqual(defaults);
  });

  it('loads Frameleaf settings and ordinary settings from the same canonical document', async () => {
    metadata.set(SystemMetadataKey.SystemConfig, {
      smartAlbums: { enabled: true },
      frameleafCloud: { signIn: { buttonText: 'Sign in to the family library' } },
      trash: { days: defaults.trash.days + 1 },
    });

    const config = await getConfig(repos(), { withCache: false });

    expect(config.smartAlbums.enabled).toBe(true);
    expect(config.smartAlbums.builtIn).toEqual(defaults.smartAlbums.builtIn);
    expect(config.frameleafCloud.signIn.buttonText).toBe('Sign in to the family library');
    expect(config.frameleafCloud.remoteAccess).toEqual(defaults.frameleafCloud.remoteAccess);
    expect(config.trash.days).toBe(defaults.trash.days + 1);
    expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.SystemConfig);
  });

  it('preserves approved file defaults on upgrade and still refuses an unrelated file edit', async () => {
    const legacy = cloneDeep(defaults);
    legacy.machineLearning.urls = ['http://immich-machine-learning:3003'];
    legacy.oauth.roleClaim = 'immich_role';
    legacy.oauth.storageQuotaClaim = 'immich_quota';
    legacy.oauth.enabled = true;
    legacy.oauth.issuerUrl = 'https://issuer.example';
    legacy.oauth.clientId = 'existing-provider';
    const partial = { oauth: { enabled: true, issuerUrl: legacy.oauth.issuerUrl, clientId: legacy.oauth.clientId } };
    const epoch = {
      format: 1 as const,
      epoch: 1,
      sourceKind: 'file' as const,
      digest: createHash('sha256').update(canonicalJson(legacy)).digest('hex'),
      trashEnabled: legacy.trash.enabled,
    };
    mocks.config.getEnv.mockReturnValue({ ...mockEnvData({}), configFile: 'settings.json' });
    mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify(partial));
    mocks.systemMetadata.getEffectiveConfigEpoch.mockResolvedValue(epoch);

    expect(await readConfig(repos())).toEqual(legacy);
    expect(mocks.systemMetadata.set).not.toHaveBeenCalled();

    mocks.systemMetadata.readFile.mockResolvedValue(
      JSON.stringify({ ...partial, trash: { days: legacy.trash.days + 1 } }),
    );
    const restarted = getMocks().config;
    restarted.getEnv.mockReturnValue({ ...mockEnvData({}), configFile: 'settings.json' });
    await expect(readConfig({ ...repos(), configRepo: restarted as never })).rejects.toThrow(
      'effective_config_activation_required',
    );
  });

  it.each([false, true])(
    'preserves restored file authority with an explicit canonical ML environment URL: %s',
    async (explicit) => {
      vi.stubEnv('FRAMELEAF_MACHINE_LEARNING_URL', explicit ? 'http://frameleaf-machine-learning:3003' : '');
      vi.stubEnv('IMMICH_MACHINE_LEARNING_URL', '');
      try {
        const legacy = cloneDeep(defaults);
        legacy.machineLearning.urls = [
          explicit ? 'http://frameleaf-machine-learning:3003' : 'http://immich-machine-learning:3003',
        ];
        legacy.oauth.roleClaim = 'immich_role';
        legacy.oauth.storageQuotaClaim = 'immich_quota';
        const binding = {
          format: 1 as const,
          recoveryId: '11111111-1111-4111-8111-111111111111',
          preparedPlanDigest: 'a'.repeat(64),
          replacementIdentity: 'b'.repeat(64),
        };
        const overlay = {
          ...binding,
          rawDigest: recoveryAuthorityDigest(legacy),
          rawAuthorityDigest: recoveryAuthorityDigest(recoveryMlConfigOf(legacy)),
          authority: { ...recoveryMlConfigOf(legacy), urls: ['http://replacement:3003'] },
        };
        const effective = applyRecoveryMlOverlay(legacy, overlay);
        metadata.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, { ...binding, quarantine: {} });
        mocks.config.getEnv.mockReturnValue({ ...mockEnvData({}), configFile: 'restored-settings.json' });
        mocks.systemMetadata.readFile.mockResolvedValue('{}');
        mocks.systemMetadata.getEffectiveConfigEpoch.mockResolvedValue({
          format: 1,
          epoch: 2,
          sourceKind: 'file',
          digest: createHash('sha256').update(canonicalJson(effective)).digest('hex'),
          trashEnabled: effective.trash.enabled,
          recoveryMl: overlay,
          recoveryMlBinding: binding,
        });

        expect(await readConfig(repos())).toEqual(effective);
        expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('round-trips a canonical save while keeping unrelated metadata and write-only credentials', async () => {
    const history = { entries: [{ id: 'history-is-separate' }] };
    metadata.set(SystemMetadataKey.SystemConfigHistory, history);
    const draft = cloneDeep(defaults);
    draft.smartAlbums.enabled = true;
    draft.frameleafCloud.signIn.buttonText = 'Sign in to the family library';
    draft.oauth.clientSecret = 'saved-oauth-secret';

    const saved = await withEffectiveConfigWrite(repos(), (bound) => updateConfig(bound, draft));

    expect(saved).toEqual(draft);
    expect(metadata.get(SystemMetadataKey.SystemConfig)).toEqual({
      smartAlbums: { enabled: true },
      frameleafCloud: { signIn: { buttonText: 'Sign in to the family library' } },
      oauth: { clientSecret: 'saved-oauth-secret' },
    });
    expect(metadata.get(SystemMetadataKey.SystemConfigHistory)).toEqual(history);
    expect(mocks.systemMetadata.set).toHaveBeenCalledTimes(2);
    expect(metadata.get(SystemMetadataKey.EffectiveConfigEpoch)).toMatchObject({
      format: 1,
      sourceKind: 'database',
      trashEnabled: draft.trash.enabled,
    });
    expect(getConfigRevision(saved)).toBe(getConfigRevision(draft));
  });

  it('restores defaults and invalidates cached settings when the canonical save clears overrides', async () => {
    metadata.set(SystemMetadataKey.SystemConfig, { smartAlbums: { enabled: true } });
    expect((await getConfig(repos(), { withCache: true })).smartAlbums.enabled).toBe(true);

    await withEffectiveConfigWrite(repos(), (bound) => updateConfig(bound, cloneDeep(defaults)));

    expect(metadata.get(SystemMetadataKey.SystemConfig)).toEqual({});
    expect(await getConfig(repos(), { withCache: true })).toEqual(defaults);
  });

  it('reloads a cached read once another process saved the settings, with no ConfigUpdate here', async () => {
    mocks.systemMetadata.getEffectiveConfigEpoch.mockImplementation(() =>
      Promise.resolve(cloneDeep(metadata.get(SystemMetadataKey.EffectiveConfigEpoch)) as never),
    );
    expect((await getConfig(repos(), { withCache: true })).trash.days).toBe(defaults.trash.days);
    // the CLI's save: the settings and their epoch change in that process; this one's cache is not cleared
    await updateConfig(repos(), {
      ...cloneDeep(defaults),
      trash: { ...defaults.trash, days: defaults.trash.days + 3 },
    });

    expect((await getConfig(repos(), { withCache: true })).trash.days).toBe(defaults.trash.days + 3);
  });

  it('fresh revision reads observe another writer while an ordinary cached read remains cached', async () => {
    const cached = await getConfig(repos(), { withCache: true });
    metadata.set(SystemMetadataKey.SystemConfig, { trash: { days: defaults.trash.days + 1 } });

    const current = await readConfig(repos());

    expect(current.trash.days).toBe(defaults.trash.days + 1);
    expect(getConfigRevision(current)).not.toBe(getConfigRevision(cached));
    expect((await getConfig(repos(), { withCache: true })).trash.days).toBe(defaults.trash.days);
  });
});
