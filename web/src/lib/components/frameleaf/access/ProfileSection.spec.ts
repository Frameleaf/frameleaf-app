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
    renderWithTooltips(ProfileSection);

    await choose(new File(['text'], 'notes.txt', { type: 'text/plain' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('frameleaf_access_profile_photo_type');
    expect(sdkMock.createProfileImage).not.toHaveBeenCalled();
  });

  it('shows why an upload failed and keeps the current photo', async () => {
    sdkMock.createProfileImage.mockRejectedValue(
      Object.assign(new Error('Bad Request'), { status: 400, data: { message: 'File is too large' } }),
    );
    renderWithTooltips(ProfileSection);

    await choose(new File(['jpeg'], 'me.jpg', { type: 'image/jpeg' }));

    await waitFor(() => expect(sdkMock.createProfileImage).toHaveBeenCalled());
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(sdkMock.getMyUser).not.toHaveBeenCalled();
  });
});
