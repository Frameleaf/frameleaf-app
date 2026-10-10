import { cloneDeep } from 'lodash-es';
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('fresh revision reads observe another writer while an ordinary cached read remains cached', async () => {
    const cached = await getConfig(repos(), { withCache: true });
    metadata.set(SystemMetadataKey.SystemConfig, { trash: { days: defaults.trash.days + 1 } });

    const current = await readConfig(repos());

    expect(current.trash.days).toBe(defaults.trash.days + 1);
    expect(getConfigRevision(current)).not.toBe(getConfigRevision(cached));
    expect((await getConfig(repos(), { withCache: true })).trash.days).toBe(defaults.trash.days);
  });
});
