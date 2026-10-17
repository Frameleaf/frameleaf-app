import { AsyncLocalStorage } from 'node:async_hooks';
import type { FrameleafCloudLink } from 'src/types.js';
import { DatabaseLock, SystemMetadataKey } from 'src/enum.js';
import { FrameleafCloudService } from 'src/services/frameleaf-cloud.service.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { newTestService } from 'test/utils.js';

const setup = () => {
  const { sut, mocks } = newTestService(FrameleafCloudService);
  const actor = UserFactory.create({ isAdmin: true });
  const link: FrameleafCloudLink = {
    status: 'linked',
    cloudUrl: 'https://cloud.test',
    instanceId: 'instance',
    accountId: 'owner',
    linkedAt: '2026-10-16T00:00:00Z',
    oidc: {
      issuer: 'https://id.cloud.test',
      clientId: 'instance',
      scope: 'openid',
      roleClaim: 'frameleaf_role',
      storageLabelClaim: '',
    },
  };
  let current = { ...link };
  const env = mocks.config.getEnv();
  mocks.config.getEnv.mockReturnValue({ ...env, frameleafCloud: { ...env.frameleafCloud, url: link.cloudUrl } });
  mocks.systemMetadata.get.mockImplementation((key) =>
    Promise.resolve((key === SystemMetadataKey.FrameleafCloudLink ? current : null) as never),
  );
  mocks.user.get.mockResolvedValue(actor as never);
  mocks.frameleafAccount.getLinkByUser.mockResolvedValue(undefined);
  mocks.frameleafAccount.getLinkBySub.mockResolvedValue(undefined);
  mocks.frameleafAccount.upsertLink.mockResolvedValue({} as never);
  mocks.adminAudit.create.mockResolvedValue();
  const held = new AsyncLocalStorage<DatabaseLock[]>();
  mocks.database.withLock.mockImplementation(
    (lock, action) => held.run([...(held.getStore() ?? []), lock], action) as never,
  );
  const internal = sut as unknown as {
    connectLinkingAdministrator: (link: FrameleafCloudLink, actor: string | undefined, email?: string) => Promise<void>;
  };
  return {
    sut,
    mocks,
    actor,
    held,
    link,
    connect: (id: string | undefined = actor.id) => internal.connectLinkingAdministrator(link, id),
    replace: (patch: Partial<FrameleafCloudLink>) => {
      current = { ...current, ...patch };
    },
  };
};

it.each(['unlinked', 'revoked', 'instance', 'owner', 'generation', 'issuer', 'client'] as const)(
  'does not connect the linking administrator after %s authority change',
  async (change) => {
    const h = setup();
    const patch: Partial<FrameleafCloudLink> =
      change === 'unlinked' || change === 'revoked'
        ? { status: change }
        : change === 'instance'
          ? { instanceId: 'replacement' }
          : change === 'owner'
            ? { accountId: 'replacement' }
            : change === 'generation'
              ? { linkedAt: 'replacement' }
              : {
                  oidc: {
                    ...h.link.oidc!,
                    ...(change === 'issuer' ? { issuer: 'https://id.replacement.test' } : { clientId: 'replacement' }),
                  },
                };
    h.replace(patch);
    await h.connect();
    expect(h.mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
    expect(h.mocks.adminAudit.create).not.toHaveBeenCalled();
  },
);

it('rereads authority after waiting for the link lock', async () => {
  const h = setup();
  h.mocks.database.withLock.mockImplementation((_lock, action) => {
    h.replace({ status: 'unlinked' });
    return action() as never;
  });
  await h.connect();
  expect(h.mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
});

it.each(['current', 'legacy'] as const)(
  'holds the Cloud fence through %s account-link and audit writes',
  async (mode) => {
    const h = setup();
    if (mode === 'legacy') {
      delete h.link.linkedAt;
      h.replace({ linkedAt: undefined });
    }
    h.mocks.frameleafAccount.upsertLink.mockImplementation((row) => {
      expect(h.held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
      expect(row).toMatchObject({ userId: h.actor.id, sub: 'owner', access: 'owner', role: 'admin' });
      return Promise.resolve({} as never);
    });
    h.mocks.adminAudit.create.mockImplementation(() => {
      expect(h.held.getStore()).toContain(DatabaseLock.FrameleafLinkAuthority);
      return Promise.resolve();
    });
    h.replace({ accountLabel: 'A new display label', lastContactAt: new Date().toISOString() });
    await h.connect();
    expect(h.mocks.frameleafAccount.upsertLink).toHaveBeenCalledOnce();
    expect(h.mocks.adminAudit.create).toHaveBeenCalledOnce();
  },
);

it.each(['not-admin', 'already-linked', 'owner-linked', 'no-actor'] as const)(
  'preserves %s account rules',
  async (mode) => {
    const h = setup();
    switch (mode) {
      case 'not-admin': {
        h.mocks.user.get.mockResolvedValue({ ...h.actor, isAdmin: false } as never);
        break;
      }
      case 'already-linked': {
        h.mocks.frameleafAccount.getLinkByUser.mockResolvedValue({ sub: 'another-owner' } as never);
        break;
      }
      case 'no-actor': {
        break;
      }
      case 'owner-linked': {
        h.mocks.frameleafAccount.getLinkBySub.mockResolvedValue({ userId: 'another-user' } as never);
        break;
      }
    }
    await h.connect(mode === 'no-actor' ? '' : h.actor.id);
    expect(h.mocks.frameleafAccount.upsertLink).not.toHaveBeenCalled();
  },
);
