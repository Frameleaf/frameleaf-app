import { UserMetadataKey } from 'src/enum.js';
import { PartnerLockedNoticeService } from 'src/services/partner-locked-notice.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

describe(PartnerLockedNoticeService.name, () => {
  let sut: PartnerLockedNoticeService;
  let mocks: ServiceMocks;
  let userMetadata: Array<{ key: UserMetadataKey; value: unknown }>;
  let hasPin: boolean;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PartnerLockedNoticeService));
    userMetadata = [];
    hasPin = false;
    mocks.user.getMetadata.mockImplementation(() => Promise.resolve(userMetadata as never));
    mocks.user.upsertMetadata.mockImplementation((_userId, item) => {
      userMetadata = [...userMetadata.filter(({ key }) => key !== item.key), item as never];
      return Promise.resolve();
    });
    mocks.user.hasPinCode.mockImplementation(() => Promise.resolve(hasPin));
  });

  it('shows nothing before any locked copy arrived', async () => {
    await expect(sut.getNotice(authStub.user1)).resolves.toEqual({ show: false, flaggedAt: null });
  });

  it('flags the notice once when a locked copy reaches an account without a PIN', async () => {
    await expect(sut.noteLockedCopy(authStub.user1.user.id)).resolves.toBe(true);
    const first = await sut.getNotice(authStub.user1);
    expect(first.show).toBe(true);
    expect(first.flaggedAt).toEqual(expect.any(String));

    // a second locked copy keeps the first record
    await expect(sut.noteLockedCopy(authStub.user1.user.id)).resolves.toBe(false);
    expect(mocks.user.upsertMetadata).toHaveBeenCalledTimes(1);
    expect(mocks.user.upsertMetadata).toHaveBeenCalledWith(authStub.user1.user.id, {
      key: UserMetadataKey.PartnerLockedNotice,
      value: { flaggedAt: first.flaggedAt, dismissedAt: null },
    });
  });

  it('never flags an account that already has a PIN', async () => {
    hasPin = true;
    await expect(sut.noteLockedCopy(authStub.user1.user.id)).resolves.toBe(false);
    expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
    await expect(sut.getNotice(authStub.user1)).resolves.toEqual({ show: false, flaggedAt: null });
  });

  it('stops showing once a PIN is set, even if it was flagged', async () => {
    await sut.noteLockedCopy(authStub.user1.user.id);
    hasPin = true;
    await expect(sut.getNotice(authStub.user1)).resolves.toMatchObject({ show: false });
  });

  it('is one-time: dismissing hides it and later locked copies do not bring it back', async () => {
    await sut.noteLockedCopy(authStub.user1.user.id);
    await expect(sut.dismiss(authStub.user1)).resolves.toMatchObject({ show: false });
    await expect(sut.noteLockedCopy(authStub.user1.user.id)).resolves.toBe(false);
    await expect(sut.getNotice(authStub.user1)).resolves.toMatchObject({ show: false });
  });

  it('dismissing without a flag records nothing', async () => {
    await expect(sut.dismiss(authStub.user1)).resolves.toEqual({ show: false, flaggedAt: null });
    expect(mocks.user.upsertMetadata).not.toHaveBeenCalled();
  });
});
