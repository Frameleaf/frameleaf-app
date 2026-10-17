import { updateUserAdmin } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleResetPasswordUserAdmin } from '$lib/services/user-admin.service';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  updateUserAdmin: vi.fn(),
}));
vi.mock('@frameleaf/ui', async (original) => ({
  ...(await original<typeof import('@frameleaf/ui')>()),
  toastManager: { primary: vi.fn() },
}));
vi.mock('$lib/utils/i18n', async (original) => ({
  ...(await original<typeof import('$lib/utils/i18n')>()),
  getFormatter: async () => (key: string) => key,
}));

describe('admin password reset', () => {
  it('uses fresh secure samples and sends the generated password only to the reset endpoint', async () => {
    const user = userAdminFactory.build();
    const buffers: Uint32Array[] = [];
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(buffer: T): T => {
      const sample = buffer as Uint32Array;
      sample[0] = buffers.length % 2 === 0 ? 0 : 0xff_ff_ff_ff;
      buffers.push(sample);
      return buffer;
    });
    vi.mocked(updateUserAdmin).mockResolvedValue(user);
    const emit = vi.spyOn(eventManager, 'emit');
    const password = await handleResetPasswordUserAdmin(user);
    expect(password).toBe('0?'.repeat(8));
    expect(buffers).toHaveLength(16);
    expect(crypto.getRandomValues).toHaveBeenCalledTimes(16);
    expect(updateUserAdmin).toHaveBeenCalledExactlyOnceWith({
      id: user.id,
      userAdminUpdateDto: { password, shouldChangePassword: true },
    });
    expect(emit).toHaveBeenCalledExactlyOnceWith('UserAdminUpdate', user);
    expect(toastManager.primary).toHaveBeenCalledOnce();
  });
});
