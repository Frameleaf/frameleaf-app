import { ServerRole, UserAvatarColor } from '@frameleaf/sdk';
import { fireEvent, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import ProfileSection from '$lib/components/frameleaf/access/ProfileSection.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { renderWithTooltips } from '$tests/helpers';
import { userAdminFactory } from '@test-data/factories/user-factory';

const choose = async (file: File) => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await fireEvent.change(input);
};

describe('ProfileSection avatar (FL-67)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authManager.setUser(userAdminFactory.build({ name: 'Taylor', email: 'taylor@example.com' }));
  });

  it('refuses a file that is not an image before uploading anything', async () => {
    renderWithTooltips(ProfileSection, {});

    await choose(new File(['text'], 'notes.txt', { type: 'text/plain' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_access_profile_photo_type');
    expect(sdkMock.createProfileImage).not.toHaveBeenCalled();
  });

  it('shows why an upload failed and keeps the current photo', async () => {
    sdkMock.createProfileImage.mockRejectedValue(
      Object.assign(new Error('Bad Request'), { status: 400, data: { message: 'File is too large' } }),
    );
    renderWithTooltips(ProfileSection, {});

    await choose(new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' }));

    await waitFor(() => expect(sdkMock.createProfileImage).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sdkMock.getMyUser).not.toHaveBeenCalled();
  });

  it('does not replace another account with a late colour response', async () => {
    const previous = { ...authManager.user, avatarColor: UserAvatarColor.Primary };
    authManager.setUser(previous);
    let finish!: (value: typeof previous) => void;
    sdkMock.updateMyUser.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderWithTooltips(ProfileSection, {});
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_prefs_colour_pink' }));
    await waitFor(() => expect(sdkMock.updateMyUser).toHaveBeenCalledOnce());
    const next = userAdminFactory.build({ name: 'Next account' });
    authManager.setUser(next);
    finish({ ...previous, avatarColor: UserAvatarColor.Pink });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(authManager.user.id).toBe(next.id);
  });

  it('does not start a profile reload after the upload session changes', async () => {
    const previous = authManager.user;
    let finish!: (value: never) => void;
    sdkMock.createProfileImage.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    sdkMock.getMyUser.mockResolvedValue({ ...previous, canUpload: true, serverRole: ServerRole.Admin });
    renderWithTooltips(ProfileSection, {});
    await choose(new File(['png'], 'me.png', { type: 'image/png' }));
    await waitFor(() => expect(sdkMock.createProfileImage).toHaveBeenCalledOnce());
    const next = userAdminFactory.build({ name: 'Next account' });
    authManager.setUser(next);
    finish({} as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.getMyUser).not.toHaveBeenCalled();
    expect(authManager.user.id).toBe(next.id);
  });

  it('does not show a previous account upload failure', async () => {
    let fail!: (error: Error) => void;
    sdkMock.createProfileImage.mockReturnValueOnce(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    renderWithTooltips(ProfileSection, {});
    await choose(new File(['png'], 'me.png', { type: 'image/png' }));
    await waitFor(() => expect(sdkMock.createProfileImage).toHaveBeenCalledOnce());
    const next = userAdminFactory.build({ name: 'Next account' });
    authManager.setUser(next);
    fail(new Error('previous account upload failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(authManager.user.id).toBe(next.id);
  });
});
